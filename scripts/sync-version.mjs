#!/usr/bin/env node
/**
 * 版本号同步 —— 单一真源是 package.json 的 version。
 *
 * 为什么需要这个脚本：版本号散在 5 个文件 7 处，插件市场、官方 MCP Registry、
 * 客户端看到的插件版本分别读不同的文件。漏改一处，用户装到的是"旧版本"，
 * 但 npm 上明明已经发了新的 —— 这种不一致极难排查。
 *
 *   .claude-plugin/marketplace.json   metadata.version + plugins[].version
 *   plugin/.claude-plugin/plugin.json version
 *   plugin/.cursor-plugin/plugin.json version（cursor.directory / Cursor 插件清单）
 *   server.json                       version + packages[].version
 *   lhm.plugin.json                   version（LobeHub 市场清单）
 *
 * 用法：
 *   node scripts/sync-version.mjs          写入（npm version 时会自动调用）
 *   node scripts/sync-version.mjs --check  只校验，不一致则以退出码 1 结束（CI 用）
 *
 * 实现上刻意用「正则替换文本」而不是 JSON.stringify 重写：
 * 后者会把文件重新排版、可能打乱字段顺序，让改动的 diff 变成整个文件，
 * 从而掩盖真正的版本变化。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

/** 待同步的文件。`min` 是预期出现次数，仅用于发现文件结构被意外改动。 */
const TARGETS = [
  { file: ".claude-plugin/marketplace.json", min: 2 },
  { file: "plugin/.claude-plugin/plugin.json", min: 1 },
  { file: "plugin/.cursor-plugin/plugin.json", min: 1 },
  { file: "server.json", min: 2 },
  { file: "lhm.plugin.json", min: 1 },
];

const VERSION_FIELD = /("version"\s*:\s*")([^"]*)(")/g;

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`package.json 的 version 不是合法 semver: ${JSON.stringify(version)}`);
}

// server.json 的 name 必须等于 package.json 的 mcpName，否则 mcp-publisher 会拒绝发布。
// 顺手校验，避免等到发布时才报错。
try {
  const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
  if (pkg.mcpName && server.name !== pkg.mcpName) {
    fail(
      `server.json 的 name (${server.name}) 与 package.json 的 mcpName (${pkg.mcpName}) 不一致`,
    );
  }
} catch (e) {
  fail(`读取 server.json 失败: ${e.message}`);
}

console.log(`版本真源 package.json = ${version}${checkOnly ? "（仅校验）" : ""}`);

let drift = 0;

for (const { file, min } of TARGETS) {
  const path = join(root, file);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    fail(`读取 ${file} 失败: ${e.message}`);
  }

  const found = [...text.matchAll(VERSION_FIELD)].map((m) => m[2]);
  if (found.length < min) {
    fail(
      `${file} 里只找到 ${found.length} 处 "version"（预期至少 ${min} 处）—— 文件结构可能变了，请先更新本脚本`,
    );
  }

  const stale = found.filter((v) => v !== version);

  if (stale.length === 0) {
    console.log(`  ✓ ${file.padEnd(36)} ${found.length} 处一致`);
    continue;
  }

  drift += 1;
  const detail = `${[...new Set(stale)].join(", ")} → ${version}（${stale.length}/${found.length} 处）`;

  if (checkOnly) {
    console.log(`  ✗ ${file.padEnd(36)} ${detail}`);
    continue;
  }

  const updated = text.replace(VERSION_FIELD, (_m, p1, _old, p3) => `${p1}${version}${p3}`);

  // 写完立刻回读解析，防止正则改坏了 JSON
  try {
    JSON.parse(updated);
  } catch (e) {
    fail(`${file} 替换后不再是合法 JSON，已中止（未写入）: ${e.message}`);
  }

  writeFileSync(path, updated);
  console.log(`  ⬆ ${file.padEnd(36)} ${detail}`);
}

if (checkOnly && drift > 0) {
  console.error(
    `\n✗ ${drift} 个文件的版本号与 package.json (${version}) 不一致。\n  在本机执行 \`npm run sync-version\` 修复后重新提交。`,
  );
  process.exit(1);
}

if (!checkOnly && drift > 0) {
  console.log(`\n已更新 ${drift} 个文件。`);
} else if (!checkOnly) {
  console.log("\n全部一致，无需改动。");
}
