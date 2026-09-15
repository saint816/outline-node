/* global process, setTimeout, window, console */
// 录制 Marketplace 首屏演示 GIF（英文版）。
// 用法: 先 npm run build，然后 node scripts/record-demo.mjs
// 产物: /tmp/outline-demo/demo.webm → ffmpeg 转 GIF
//
// 原理: 打开 test/webview/harness.html（lang=en → 插件 UI 全英文），注入英文大纲，
// 依次演示 折叠/展开 → 内联编辑 → zoom → 搜索，Playwright 录屏。
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const W = 880;
const H = 400;
const OUT = '/tmp/outline-demo';
mkdirSync(OUT, { recursive: true });

const HARNESS = 'file://' + resolve(process.cwd(), 'test/webview/harness.html');

// ---------- 英文演示数据 ----------
function n(id, text, children = [], extra = {}) {
  return { id, text, checked: null, note: null, blockId: null, mirror: null, children, raw: null, ...extra };
}
const roots = [
  n('a', 'This Week', [
    n('a1', 'Write report', [
      n('a11', "Gather last week's data"),
      n('a12', 'Summarize into a chart', [], { checked: false }),
    ]),
    n('a2', 'Book flight'),
  ]),
  n('b', 'Ideas', [
    n('b1', 'Outlines are Markdown — no proprietary format'),
    n('b2', 'Mirror blocks keep data in one place'),
  ]),
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: OUT, size: { width: W, height: H } },
});
const page = await context.newPage();

// 关掉侧栏占位噪点？先看默认布局，若太挤再收起。
await page.goto(HARNESS);
await page.waitForFunction(() => window.__posted?.length > 0);

await page.evaluate(
  ({ snapshot, config }) =>
    window.__inject({
      type: 'init',
      snapshot,
      version: 1,
      foldedKeys: [],
      bookmarkKeys: [],
      config,
    }),
  {
    snapshot: { indentUnit: { kind: 'space', width: 2 }, blocks: [{ kind: 'list', id: 'l1', roots }] },
    config: { defaultIndent: { kind: 'space', width: 2 }, defaultFold: 'none', rememberFolding: true },
  },
);
await page.waitForSelector('.node');
await sleep(1200); // 开场定格：完整大纲

// 1) 折叠 / 展开 This Week
await page.locator('.node[data-id="a"] > .node-row > .toggle').click();
await sleep(900);
await page.locator('.node[data-id="a"] > .node-row > .toggle').click();
await sleep(1100);

// 2) 内联编辑：Write report → Weekly report（Enter 进入编辑在 keymap 是点击后直接打字）
const textSel = '.node[data-id="a1"] > .node-row > [data-field="text"]';
await page.locator(textSel).click();
await sleep(600);
await page.keyboard.press('Meta+A');
await page.keyboard.type('Weekly report', { delay: 70 });
await sleep(900);

// 3) zoom 进入 This Week（点圆点）
await page.locator('.node[data-id="a"] > .node-row > .bullet').click();
await sleep(1400); // 面包屑 All > This Week

// 4) 展开子节点（zoom 根下 Write report 若折叠先展开）
await page.locator('.node[data-id="a1"] > .node-row > .toggle').click();
await sleep(1000);

// 5) 搜索 "flight"
await page.locator('.search-input').click();
await page.keyboard.type('flight', { delay: 90 });
await sleep(1300);

// 6) 清空搜索，展示过滤恢复
await page.locator('.search-input').fill('');
await sleep(900);

// 7) 回到 All（zoom out）—— 若有工具条 back；直接再点一次顶层 zoom out 或等渲染
// 定格 1 秒收尾
await sleep(1200);

await browser.close();
console.log('recorded to', OUT, '— convert with ffmpeg');
