// MCP 工具定义与接线:14 个工具,统一走 ensureReady / 错误整形 / 文本预算
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Page } from "playwright-core";
import type { BrowserManager } from "./browserManager.js";
import type { RefRegistry } from "./snapshot.js";
import { snapshotPage } from "./snapshot.js";
import {
  doClick,
  doEvaluate,
  doHover,
  doPressKey,
  doScreenshot,
  doScroll,
  doSelectOption,
  doType,
  doWait,
  formatAfter,
  resolveTarget,
} from "./actions.js";
import { ToolError, shapeError } from "./errors.js";
import { safeStringify, truncate } from "./util.js";

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

interface ToolDef extends Tool {
  handler: Handler;
  /** 调用前是否自动启动/恢复浏览器 */
  needsBrowser: boolean;
}

function text(content: string): CallToolResult {
  return { content: [{ type: "text", text: content }] };
}

function textError(shape: { code: string; message: string; hint?: string }): CallToolResult {
  const lines = [`❌ [${shape.code}] ${shape.message}`];
  if (shape.hint) lines.push(`💡 ${shape.hint}`);
  return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
}

const STR = { type: "string" } as const;
const NUM = { type: "number" } as const;
const BOOL = { type: "boolean" } as const;

function strEnum(values: string[]): { type: "string"; enum: string[] } {
  return { type: "string", enum: values };
}

export function registerTools(server: Server, manager: BrowserManager, registry: RefRegistry): void {
  // ---------- 公共助手 ----------

  async function requireActivePage(): Promise<{ page: Page; pageId: string; created: boolean }> {
    await manager.ensureReady();
    const ctx = manager.getContext();
    const page = manager.session.getActive();
    if (page) {
      const all = manager.session.listTabs();
      const active = all.find((t) => t.active) ?? all[0];
      if (active) return { page, pageId: active.id, created: false };
    }
    const newPage = await ctx.newPage();
    const pageId = manager.session.adopt(newPage, { activate: true });
    return { page: newPage, pageId, created: true };
  }

  function activePageId(): string | undefined {
    return manager.session.listTabs().find((t) => t.active)?.id;
  }

  async function attachSnapshot(
    out: string[],
    page: Page,
    args: Record<string, unknown>,
    filter: "balanced" | "interactive" | "text" = "balanced",
  ): Promise<void> {
    if (args.snapshot === false) return;
    const pageId = activePageId() ?? "?";
    const snap = await snapshotPage(page, pageId, registry, { filter });
    out.push("", "── 最新快照 ──", snap.text);
  }

  function capOut(s: string): string {
    return s.length > manager.cfg.resultMaxChars
      ? s.slice(0, manager.cfg.resultMaxChars) + `\n…(结果超过 ${manager.cfg.resultMaxChars} 字符被截断,请缩小查询范围)`
      : s;
  }

  // ---------- 工具定义 ----------

  const tools: ToolDef[] = [
    {
      name: "browser_navigate",
      description:
        "Navigate to a URL. Returns a snapshot of interactive elements with [eN] refs that feed straight into click/type. Adds https:// when the protocol is missing.",
      inputSchema: {
        type: "object",
        properties: {
          url: { ...STR, description: "Target URL" },
          newTab: { ...BOOL, description: "Open in a new tab (default false: navigate the current tab)" },
          timeoutMs: { ...NUM, description: "Navigation timeout in ms (default 30000)" },
          snapshot: { ...BOOL, description: "Include a snapshot in the result (default true)" },
        },
        required: ["url"],
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        let url = String(args.url).trim();
        if (!/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url) && !/^about:/i.test(url)) {
          url = "https://" + url;
        }
        const ctx = manager.getContext();
        let page: Page;
        let pageId: string;
        if (args.newTab === true) {
          page = await ctx.newPage();
          pageId = manager.session.adopt(page, { activate: true });
        } else {
          const active = await requireActivePage();
          page = active.page;
          pageId = active.pageId;
        }
        registry.clearPage(pageId); // 导航后旧 ref 作废
        const out: string[] = [];
        const timeout = typeof args.timeoutMs === "number" ? args.timeoutMs : manager.cfg.navTimeoutMs;
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/Timeout/i.test(msg)) {
            out.push(`⚠️ 导航超时(${timeout}ms),页面可能仍在加载。当前 URL: ${page.url()}`);
            out.push("💡 可直接 browser_snapshot 看看已加载的部分,或用 browser_wait {idle:true} 再等网络空闲。");
          } else {
            throw e;
          }
        }
        manager.session.markDirty();
        const title = await page.title().catch(() => "");
        out.push(`✅ 已打开: ${title || "(无标题)"} — ${page.url()}`);
        const popups = manager.popupsSince(Date.now() - 2000);
        for (const p of popups) out.push(`🪟 检测到新标签页 → ${p.url}`);
        await attachSnapshot(out, page, args);
        return text(capOut(out.join("\n")));
      },
    },
    {
      name: "browser_snapshot",
      description:
        "Semantic snapshot of the current page: interactive elements carry [eN] refs, and iframe content is flattened in. Narrow it with rootRef (the subtree of a single element), selector, or filter:interactive (interactive elements only).",
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            ...strEnum(["balanced", "interactive", "text"]),
            description:
              "balanced (default) keeps structure and text, interactive keeps only interactive elements, text keeps only text",
          },
          rootRef: { ...STR, description: "Snapshot only this element's subtree" },
          selector: { ...STR, description: "Snapshot only the subtree matching this CSS selector (main document)" },
          maxElements: { ...NUM, description: "Maximum output rows (default 400)" },
        },
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        const { page } = await requireActivePage();
        const pageId = activePageId() ?? "?";
        const snap = await snapshotPage(page, pageId, registry, {
          filter: args.filter as never,
          rootRef: args.rootRef as string | undefined,
          rootSelector: args.selector as string | undefined,
          maxElements: typeof args.maxElements === "number" ? args.maxElements : undefined,
          title: await page.title().catch(() => ""),
        });
        return text(capOut(snap.text));
      },
    },
    {
      name: "browser_click",
      description:
        "Click an element (prefer the ref from a snapshot). Waits until it is actionable, re-resolves refs that went stale, and returns a fresh snapshot afterwards. Dialogs are handled and reported automatically.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { ...STR, description: "The [eN] id shown in a snapshot" },
          selector: { ...STR, description: "CSS selector (fallback when no ref is available)" },
          text: { ...STR, description: "Match by visible text" },
          button: strEnum(["left", "right", "middle"]),
          doubleClick: { ...BOOL },
          timeoutMs: { ...NUM },
          snapshot: { ...BOOL, description: "Include a snapshot after clicking (default true)" },
        },
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        const { page } = await requireActivePage();
        const { target, after } = await doClick(manager, page, registry, args as never);
        const out: string[] = [];
        out.push("✅ 已点击。" + (target.notes.length ? "\n" + target.notes.join("\n") : ""));
        const afterText = formatAfter(after);
        if (afterText) out.push(afterText);
        await attachSnapshot(out, page, args);
        return text(capOut(out.join("\n")));
      },
    },
    {
      name: "browser_type",
      description: "Type text into a field (clears it first). submit:true presses Enter. Works with input/textarea/contenteditable.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { ...STR },
          selector: { ...STR },
          text: { ...STR, description: "Text to type" },
          submit: { ...BOOL, description: "Press Enter after typing (default false)" },
          clear: { ...BOOL, description: "Clear the field first (default true; false appends)" },
          timeoutMs: { ...NUM },
        },
        required: ["text"],
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        const { page } = await requireActivePage();
        const { target, after } = await doType(manager, page, registry, args as never);
        const out: string[] = [];
        out.push(`✅ 已输入: ${JSON.stringify(truncate(String(args.text), 80))}` + (args.submit ? " 并回车提交。" : ".") + (target.notes.length ? "\n" + target.notes.join("\n") : ""));
        const afterText = formatAfter(after);
        if (afterText) out.push(afterText);
        await attachSnapshot(out, page, args);
        return text(capOut(out.join("\n")));
      },
    },
    {
      name: "browser_press_key",
      description: 'Press a key, e.g. Enter / Tab / ArrowDown / Control+a. With a ref, focuses that element first.',
      inputSchema: {
        type: "object",
        properties: {
          key: { ...STR, description: "Key name, e.g. Enter, Escape, ArrowDown, Control+a" },
          ref: { ...STR, description: "Focus this element before pressing" },
        },
        required: ["key"],
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        const { page } = await requireActivePage();
        const { after } = await doPressKey(manager, page, registry, args as never);
        const out: string[] = [`✅ 已按下 ${args.key}。`];
        const afterText = formatAfter(after);
        if (afterText) out.push(afterText);
        return text(capOut(out.join("\n")));
      },
    },
    {
      name: "browser_select_option",
      description: "Select options in a dropdown. values may be option values or visible labels; both are tried.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { ...STR },
          selector: { ...STR },
          values: { type: "array", items: STR, description: "Option value(s) or visible label(s) to select" },
          timeoutMs: { ...NUM },
        },
        required: ["values"],
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        const { page } = await requireActivePage();
        const { selected, after } = await doSelectOption(manager, page, registry, args as never);
        const out: string[] = [`✅ 已选中: ${JSON.stringify(selected)}`];
        const afterText = formatAfter(after);
        if (afterText) out.push(afterText);
        await attachSnapshot(out, page, args);
        return text(capOut(out.join("\n")));
      },
    },
    {
      name: "browser_hover",
      description: "Hover an element to reveal hover-only menus or tooltips.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { ...STR },
          selector: { ...STR },
          timeoutMs: { ...NUM },
        },
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        const { page } = await requireActivePage();
        const { target, after } = await doHover(manager, page, registry, args as never);
        const out: string[] = ["✅ 已悬停。" + (target.notes.length ? "\n" + target.notes.join("\n") : "")];
        const afterText = formatAfter(after);
        if (afterText) out.push(afterText);
        await attachSnapshot(out, page, args);
        return text(capOut(out.join("\n")));
      },
    },
    {
      name: "browser_scroll",
      description: "Scroll the page, or one scroll container when a ref is given. Direction plus pixel amount.",
      inputSchema: {
        type: "object",
        properties: {
          direction: strEnum(["up", "down", "left", "right"]),
          amount: { ...NUM, description: "Pixels to scroll (default 600)" },
          ref: { ...STR, description: "Scroll this container instead (the one marked scrollable in a snapshot)" },
        },
        required: ["direction"],
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        const { page } = await requireActivePage();
        const { after } = await doScroll(manager, page, registry, args as never);
        const out: string[] = ["✅ 已滚动。" ];
        const afterText = formatAfter(after);
        if (afterText) out.push(afterText);
        return text(capOut(out.join("\n")));
      },
    },
    {
      name: "browser_screenshot",
      description: "Screenshot the viewport, the full page, or a single element (ref). Returns the image and writes it to disk.",
      inputSchema: {
        type: "object",
        properties: {
          fullPage: { ...BOOL, description: "Capture the full page instead of the viewport" },
          ref: { ...STR, description: "Capture only this element" },
          filename: { ...STR, description: "File name without extension (default: timestamp)" },
        },
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        const { page } = await requireActivePage();
        const shot = await doScreenshot(manager, page, registry, args as never);
        return {
          content: [
            { type: "image", data: shot.base64, mimeType: shot.mimeType },
            { type: "text", text: `✅ 截图已保存 → ${shot.file}` },
          ],
        };
      },
    },
    {
      name: "browser_evaluate",
      description:
        "Escape hatch: run JS in the page and return a JSON-serializable result. Pass a function string such as `() => document.title` or `() => {...}`; with a ref the function runs on that element as `(el) => el.value`.",
      inputSchema: {
        type: "object",
        properties: {
          js: { ...STR, description: "Function string, e.g. `() => document.querySelector('#app')?.innerText.slice(0,2000)`" },
          ref: { ...STR, description: "Run on this element; it becomes the first callback argument" },
        },
        required: ["js"],
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        const { page } = await requireActivePage();
        const { result } = await doEvaluate(manager, page, registry, args as never);
        const s = safeStringify(result, 8000);
        return text(capOut(`✅ 执行结果:\n${s === undefined ? "undefined" : s}`));
      },
    },
    {
      name: "browser_wait",
      description: 'Wait for a condition: timeMs (fixed delay) / text (appears) / selector (appears) / url (changes) / idle (network quiet). Combine them freely.',
      inputSchema: {
        type: "object",
        properties: {
          timeMs: { ...NUM },
          text: { ...STR, description: "Wait until this text appears on the page" },
          selector: { ...STR },
          url: { ...STR, description: "Wait until the URL matches this pattern" },
          idle: { ...BOOL, description: "Wait for network idle (max 15s)" },
          timeoutMs: { ...NUM, description: "Wait timeout (default 15000)" },
        },
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        const { page } = await requireActivePage();
        const { waited, notes } = await doWait(manager, page, args as never);
        const out: string[] = [`✅ ${waited}。`];
        for (const n of notes) out.push(`⚠️ ${n}`);
        return text(capOut(out.join("\n")));
      },
    },
    {
      name: "browser_tabs",
      description: "Manage tabs: list / new / select (by the index or id that list shows) / close.",
      inputSchema: {
        type: "object",
        properties: {
          action: strEnum(["list", "new", "select", "close"]),
          url: { ...STR, description: "URL to open with new (optional)" },
          index: { ...NUM, description: "Target tab index for select/close (as shown by list, 0-based)" },
          id: { ...STR, description: "Target tab pageId for select/close" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        const action = String(args.action);
        const ctx = manager.getContext();
        const tabs = manager.session.listTabs();
        if (action === "list") {
          const lines = tabs.map(
            (t, i) => `${t.active ? "▶" : " "} [${i}] id=${t.id} ${t.title || "(无标题)"} — ${t.url}`,
          );
          return text(capOut(`共 ${tabs.length} 个标签页:\n${lines.join("\n") || "(无)"}`));
        }
        if (action === "new") {
          const page = await ctx.newPage();
          const id = manager.session.adopt(page, { activate: true });
          const url = typeof args.url === "string" && args.url.trim() ? args.url.trim() : "about:blank";
          if (url !== "about:blank") await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
          manager.session.markDirty();
          return text(`✅ 新标签页已打开 → ${url}(id=${id})`);
        }
        // select / close 需要目标
        const byIndex = typeof args.index === "number" ? tabs[args.index]?.id : undefined;
        const targetId = (typeof args.id === "string" && args.id) || byIndex;
        if (!targetId) {
          throw new ToolError("missing_target", "select/close 需要指定 index 或 id", "先 browser_tabs {action:'list'} 查看标签列表");
        }
        const targetPage = manager.pageById(targetId);
        if (!targetPage) {
          throw new ToolError("not_found", `标签 ${targetId} 不存在或已关闭`, "先 browser_tabs {action:'list'} 查看标签列表");
        }
        if (action === "select") {
          manager.session.setActive(targetId);
          const title = await targetPage.title().catch(() => "");
          return text(`✅ 已切换到标签: ${title} — ${targetPage.url()}`);
        }
        // close
        await targetPage.close().catch(() => {});
        manager.session.remove(targetId);
        manager.session.markDirty();
        const remaining = manager.session.listTabs();
        if (remaining.length === 0) {
          const page = await ctx.newPage();
          manager.session.adopt(page, { activate: true });
          return text("✅ 已关闭最后一个标签,已新建空白页。");
        }
        return text(`✅ 已关闭标签(id=${targetId}),剩余 ${remaining.length} 个。`);
      },
    },
    {
      name: "browser_get_info",
      description: "Browser health: mode, tab list, restart count, recent errors / dialogs / downloads. Never launches the browser.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      needsBrowser: false,
      handler: async () => {
        const tabs = manager.session.listTabs();
        const info = {
          mode: manager.cfg.mode,
          state: manager.state,
          headless: manager.cfg.headless,
          channels: manager.cfg.channels,
          profileDir: manager.cfg.profileDir,
          restartCount: manager.restartCount,
          launchedAt: manager.launchedAt ? new Date(manager.launchedAt).toISOString() : null,
          lastError: manager.lastError,
          browserPids: manager.browserPids,
          tabs: tabs.map((t, i) => ({ index: i, id: t.id, active: t.active, title: t.title, url: t.url })),
          recentDialogs: manager.recentDialogs.slice(-5),
          recentDownloads: manager.recentDownloads.slice(-5),
          registryRefs: registry.size,
          logDir: manager.cfg.logDir,
        };
        return text(safeStringify(info, 6000) ?? "{}");
      },
    },
    {
      name: "browser_close",
      description: "Close the browser (launch mode quits it but keeps profile logins; connect mode only disconnects). The next tool call restarts it automatically.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      needsBrowser: false,
      handler: async () => {
        await manager.shutdown();
        return text("✅ 浏览器已关闭。" + (manager.cfg.mode === "launch" ? `profile 已保留(${manager.cfg.profileDir}),下次启动登录态仍在。` : "外部浏览器未被关闭。"));
      },
    },
  ];

  // ---------- 注册到 Server ----------

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })) as Tool[],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const def = tools.find((t) => t.name === name);
    if (!def) {
      return textError({ code: "unknown_tool", message: `未知工具: ${name}`, hint: "tools/list 查看可用工具" });
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (def.needsBrowser) {
        const notes = await manager.ensureReady();
        if (notes.length > 0 && notes.some((n) => n.includes("重启"))) {
          // 重启提示在最前面
          const result = await def.handler(args);
          const first = (result.content?.[0] as { type: string; text?: string }) ?? null;
          if (first?.type === "text" && first.text) {
            first.text = notes.join("\n") + "\n" + first.text;
          }
          return result;
        }
      }
      return await def.handler(args);
    } catch (e) {
      return textError(shapeError(e));
    }
  });
}
