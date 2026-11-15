# browser-ref-mcp

[![npm](https://img.shields.io/npm/v/browser-ref-mcp)](https://www.npmjs.com/package/browser-ref-mcp)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

**A reliable browser-control MCP server for AI agents.** Click by `ref`, not by brittle CSS selectors — and when the browser dies, the next call just brings it back.

Built for the two things that actually break agent-driven browsing:

| The problem | What happens with most browser tools | What this server does |
|---|---|---|
| **The agent can't click what it sees** | Selectors go stale between snapshot and click, shadow DOM and cross-origin iframes are invisible, the agent retries blindly | Semantic snapshot with `[eN]` refs, shadow DOM and cross-origin iframes flattened into one tree, four-level resolution fallback |
| **Sessions keep dying** | Browser closed by hand, process crash, port conflict — and the agent is stuck until you restart everything | Resident process, lazy restart on next call, tab session restored, orphan cleanup, timeout guardrails |

No browser download. It drives the Chrome or Edge you already have, via `playwright-core`.

Works with Claude Code, Claude Desktop, Cursor, Cline, Codex CLI, Windsurf, OpenClaw, and any client that speaks stdio MCP.

---

## Quick start

```bash
npx -y browser-ref-mcp
```

Or add it to your client config:

```json
{
  "mcpServers": {
    "browser-ref-mcp": {
      "command": "npx",
      "args": ["-y", "browser-ref-mcp"]
    }
  }
}
```

Restart the client **completely** (on macOS quit from the menu bar — closing the window does not reload config).

<details>
<summary>Install from source instead</summary>

```bash
git clone https://github.com/zy2755/browser-ref-mcp.git
cd browser-ref-mcp
npm install && npm run build
```

Then point `command` at `node` and `args` at the **absolute** path of `dist/index.js` — GUI apps often don't inherit your shell's working directory, so relative paths tend to fail:

```json
{
  "mcpServers": {
    "browser-ref-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/browser-ref-mcp/dist/index.js"]
    }
  }
}
```

Config file locations:

- **Claude Desktop** — macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- **Cursor** — `~/.cursor/mcp.json`, or Settings → Features → MCP
- **Claude Code** — `claude mcp add`, or the same `mcpServers` shape

</details>

---

## The 14 tools

| Tool | What it does |
|---|---|
| `browser_navigate(url)` | Navigate — automatically returns an interactive-element snapshot |
| `browser_snapshot` | Semantic snapshot. `filter: "interactive"` for interactive elements only, `rootRef` to scope to one subtree |
| `browser_click(ref)` | Click by ref, returns a fresh snapshot. Stale refs are re-resolved automatically |
| `browser_type(ref, text)` | Type into a field (clears first). `submit: true` presses Enter |
| `browser_press_key(key)` | Key press, e.g. `Enter` / `Escape` / `Control+a` |
| `browser_select_option(ref, values)` | Pick `<select>` options by value or label, two-pass match |
| `browser_hover(ref)` | Hover to reveal hover-only menus |
| `browser_scroll(direction, amount, ref?)` | Scroll the page, or a specific scroll container |
| `browser_screenshot` | Screenshot — returns the image and writes it to disk |
| `browser_evaluate(js)` | Escape hatch: run JS in the page |
| `browser_wait` | Wait for a duration, text, element, URL change, or network idle |
| `browser_tabs` | Multi-tab: `list` / `new` / `select` / `close` |
| `browser_get_info` | Health state, tab list, restart count, last error |
| `browser_close` | Close the browser (profile logins are kept) |

### Using refs

Every interactive element in a snapshot carries an `[eN]` label:

```
[e38] link "Sign in"
[e42] textbox "Email"
[e51] button "Continue"
```

So the agent calls `browser_click({ "ref": "e42" })` — no selector guessing, no DOM archaeology. Elements inside iframes are flattened into the same tree with the same numbering, including across origins.

---

## How clicking actually works

Most "click by selector" failures come from the page changing between the moment the agent reads it and the moment it clicks. This server separates *reading* from *locating*:

1. **Semantic snapshot** — an in-page DOM walk (accessibility role + accessible name + `cursor: pointer` heuristics) that pierces **open shadow DOM** and flattens **cross-origin iframe** content into a single tree.
2. **Ref → locator recipe** — each ref stores both a CSS path (id-anchored + `nth-of-type`, unique within its frame) *and* a role+name semantic description.
3. **Resolution fallback chain** — `cssPath` → `getByRole` exact → `getByRole` fuzzy → `getByText`. Anything that hits is validated before use.
4. **Never a dead end** — if a ref is truly dead, the error message tells the agent what to do next (re-snapshot, or wait first) instead of leaving it stuck in a retry loop.

## How reconnection works

- **Process model** — the MCP server itself is a resident daemon (stdio clients hold it open). The browser launches over a **CDP pipe**, not a websocket port, so there are no port conflicts.
- **Lazy restart** — a health check runs before every tool call (`browser.isConnected()`). If the browser was closed by hand or crashed, the next call relaunches it and **restores all tabs**, explicitly telling the agent that old refs are invalid.
- **Orphan cleanup** — if a leftover process is holding the profile, it is killed by profile path before retrying.
- **Hang guardrails** — every Playwright call is wrapped in `withTimeout`, so a frozen browser returns a timeout instead of hanging forever.
- **Full-chain logging** — `~/.browser-mcp/logs/server-YYYYMMDD.log` (2 MB rotation, 3 files kept). `browser_get_info` exposes the last error and restart count.

---

## Browser modes

**`launch` mode (default)** — starts a dedicated Chrome with its profile at `~/.browser-mcp/profile`. Logins persist across restarts. You sign in to a given site once in this profile.

**`connect` mode** — attach to an already-running browser that has a debugging port open; it is not killed on exit:

```bash
# start Chrome with a debugging port first
chrome.exe --remote-debugging-port=9222

node dist/index.js --connect          # defaults to http://127.0.0.1:9222
node dist/index.js --cdp-url http://127.0.0.1:9223
```

## Configuration

Precedence: CLI args > env vars (`BROWSER_MCP_*`) > `~/.browser-mcp/config.json` > built-in defaults.

Common flags: `--headless` / `--profile <dir>` / `--channels chrome,msedge` / `--executable <path>` / `--viewport 1440x900` / `--start-url <url>` / `--dialogs accept|dismiss` (default `accept`).

Append them after the package name:

```json
"args": ["-y", "browser-ref-mcp", "--headless", "--channels", "msedge"]
```

Full list: `npx -y browser-ref-mcp --help`.

> **Don't set `executablePath` unless you have to.** Once it is set, the `channels` fallback chain (`chrome` → `msedge`) is skipped and only that single candidate remains — which lowers robustness across machines.

---

## Security notes

- The dedicated profile holds live logins (cookies) — it *is* your browser identity. Never commit `~/.browser-mcp/profile` to any repository.
- Page dialogs are auto-accepted by default. The agent cannot handle CAPTCHAs or payment flows; those still need a human.
- Logs may contain page URLs including query parameters — clean them up after debugging.

## Roadmap

File upload, richer download management, request interception, cookie/storage management, PDF export, a CLI front end.

## License

[Apache-2.0](./LICENSE)

---

[中文说明](./README.zh-CN.md)
