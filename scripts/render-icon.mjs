#!/usr/bin/env node
/**
 * 把 plugin/logo.svg 渲染成 512×512 的 PNG（plugin/logo.png）。
 *
 * 为什么要走浏览器渲染：Node 里没有原生的 SVG 光栅化能力，
 * 而装 sharp / resvg 要额外拉几十 MB 的原生二进制。
 * 这个项目本来就依赖 playwright-core，直接用系统已装的 Edge 渲染，
 * 零新增依赖，且渲染结果与浏览器里看到的完全一致。
 *
 * 用法：node scripts/render-icon.mjs
 */
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = 512;

const svg = readFileSync(join(root, "plugin/logo.svg"), "utf8");

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: SIZE, height: SIZE },
    deviceScaleFactor: 1,
  });
  // margin 必须清零，否则 SVG 会带上偏移；背景透明交给 SVG 自己画。
  await page.setContent(
    `<!doctype html><html><body style="margin:0;padding:0;background:transparent">${svg}</body></html>`,
    { waitUntil: "load" },
  );

  await page.screenshot({
    path: join(root, "plugin/logo.png"),
    omitBackground: true,
    clip: { x: 0, y: 0, width: SIZE, height: SIZE },
  });
  console.log(`✓ 已生成 plugin/logo.png (${SIZE}×${SIZE})`);
} finally {
  await browser.close();
}
