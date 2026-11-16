#!/usr/bin/env node
/**
 * LobeHub 市场清单（lhm.plugin.json）的所有者元数据补丁。
 *
 * 为什么需要它：`lhm plugin init --force` 是唯一能刷新 tools 列表的办法，
 * 但它每次都会用"从 package.json / git remote 推断出来的值"覆盖整份清单 ——
 * 展示名会退回包名、分类和图标会丢、zh-CN 人工翻译会被抹掉。
 *
 * 所以发版流程固定为三步：
 *   1. npx -y @lobehub/market-cli plugin init --force --stdio "node dist/index.js" --dir .
 *   2. node scripts/lhm-manifest.mjs          # 本脚本，幂等
 *   3. npx -y @lobehub/market-cli plugin update --dir .
 *
 * 用法：node scripts/lhm-manifest.mjs [--check]
 *   --check 只校验，不写文件（CI / 发布前自检用）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "lhm.plugin.json");
const checkOnly = process.argv.includes("--check");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** 所有者字段：init 不会正确生成，每次都要覆盖回来。 */
const OWNER = {
  name: "Browser Ref MCP", // 市场展示名，不能是包名
  author: "zy2755",
  authorUrl: "https://github.com/zy2755",
  category: "developer", // 首发布必须是市场分类枚举
  homepage: "https://github.com/zy2755/browser-ref-mcp",
  // 🔴 不能用 raw.githubusercontent.com：那个域名国内基本不可达，
  // 而 LobeHub 的主力用户在国内，会看到裂图。gcore 是 jsdelivr 的国内可达镜像。
  icon: "https://gcore.jsdelivr.net/gh/zy2755/browser-ref-mcp@main/plugin/logo.png",
  tags: ["browser-automation", "browser-control", "playwright", "web-scraping", "ai-agent", "chrome", "edge"],
  // en-US 是源、永不机翻；其他语言 LobeHub 会自动翻，但这里给了就以这里为准。
  localizations: [
    {
      locale: "zh-CN",
      name: "浏览器 Ref 控制",
      description:
        "让 AI 直接操作你本机已有的 Chrome/Edge：页面快照带编号 ref，按 ref 点击而不靠易碎的 CSS 选择器，浏览器挂了下次调用自动重启并恢复标签页。",
    },
  ],
};

/** 字段顺序固定，避免每次 init 都产生无意义的 diff。 */
const ORDER = [
  "identifier",
  "name",
  "version",
  "author",
  "authorUrl",
  "category",
  "description",
  "homepage",
  "icon",
  "tags",
  "localizations",
  "tools",
  "resources",
  "prompts",
];

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  fail(`读取 lhm.plugin.json 失败: ${e.message}\n  先跑 plugin init 生成清单。`);
}

if (!manifest.identifier) fail("lhm.plugin.json 缺 identifier（init 应该会写）");
if (!Array.isArray(manifest.tools)) fail("lhm.plugin.json 缺 tools 数组");

const next = { ...manifest, ...OWNER, version: pkg.version };
// description 用 package.json 的，保证与 npm / Registry 三处一致
next.description = pkg.description;

const out = {};
for (const k of ORDER) if (next[k] !== undefined) out[k] = next[k];

const serialized = JSON.stringify(out, null, 2) + "\n";
const current = readFileSync(file, "utf8").replace(/\r\n/g, "\n");

if (checkOnly) {
  const drifted = Object.keys(OWNER).filter(
    (k) => JSON.stringify(manifest[k]) !== JSON.stringify(OWNER[k]),
  );
  if (out.version !== pkg.version) drifted.push("version");
  if (drifted.length) {
    fail(`清单与预期不一致：${drifted.join(", ")}。跑 node scripts/lhm-manifest.mjs 修复。`);
  }
  console.log("✓ lhm.plugin.json 所有者字段与环境一致");
  process.exit(0);
}

if (current === serialized) {
  console.log("✓ 清单无需改动");
  process.exit(0);
}

writeFileSync(file, serialized);
console.log(
  `✓ 已应用所有者字段：${Object.keys(OWNER).join(", ")}；version=${next.version}；tools=${out.tools.length}`,
);
