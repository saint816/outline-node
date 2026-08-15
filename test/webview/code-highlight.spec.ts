// 代码块的语法高亮 + 复制按钮。高亮层是 textarea 背后的 <pre>，两层必须严格对齐，
// 否则整块代码「重影」；复制走宿主剪贴板（webview 里的浏览器剪贴板 API 有静默失败前科）。
import { expect, test, type Page } from '@playwright/test';
import { clearPosted, inject, node, openOutline, posted } from './support.js';

const TS = '```ts\nconst n = 42; // 注释\n```';

function fence(note: string): { id: string; text: string; note: string; children: [] } {
  return { id: 'a', text: '示例', note, children: [] };
}

/** 高亮层与 textarea 在排版上必须逐条一致的属性。 */
async function layoutPair(page: Page): Promise<[Record<string, string>, Record<string, string>]> {
  return page.evaluate(() => {
    const pick = (el: Element): Record<string, string> => {
      const c = getComputedStyle(el);
      return {
        font: `${c.fontFamily}|${c.fontSize}|${c.fontWeight}`,
        lineHeight: c.lineHeight,
        padding: `${c.paddingTop} ${c.paddingRight} ${c.paddingBottom} ${c.paddingLeft}`,
        border: c.borderWidth,
        letterSpacing: c.letterSpacing,
        whiteSpace: c.whiteSpace,
        tabSize: c.tabSize,
      };
    };
    return [
      pick(document.querySelector('.code-hl')!),
      pick(document.querySelector('textarea.code-input')!),
    ];
  });
}

test('已知语言渲染出 token，且各类 token 颜色互不相同', async ({ page }) => {
  await openOutline(page, [fence(TS)]);

  await expect(page.locator('.code-hl .token.keyword')).not.toHaveCount(0);
  const colors = await page.evaluate(() => {
    const color = (sel: string): string | null => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).color : null;
    };
    return {
      keyword: color('.code-hl .token.keyword'),
      number: color('.code-hl .token.number'),
      comment: color('.code-hl .token.comment'),
      plain: getComputedStyle(document.querySelector('.code-hl')!).color,
    };
  });
  expect(new Set([colors.keyword, colors.number, colors.comment, colors.plain]).size).toBe(4);
});

test('高亮层与 textarea 的排版逐条一致（错一条整块代码就重影）', async ({ page }) => {
  await openOutline(page, [fence(TS)]);
  const [hl, area] = await layoutPair(page);
  expect(hl).toEqual(area);
});

test('未知语言 / 无语言不建高亮层，代码块照常可编辑', async ({ page }) => {
  await openOutline(page, [fence('```\nplain text\n```')]);
  await expect(page.locator('.code-hl')).toHaveCount(0);
  await expect(page.locator('.raw-block.code-block.highlighted')).toHaveCount(0);
  await expect(page.locator('textarea.code-input')).toHaveValue('plain text');
});

test('超过 240px 的代码块默认收起，可展开；聚焦编辑会自动展开并保存 UI 状态', async ({ page }) => {
  const longCode = Array.from({ length: 30 }, (_, i) => `const n${i} = ${i};`).join('\n');
  await openOutline(page, [fence(`\`\`\`ts\n${longCode}\n\`\`\``)]);
  const block = page.locator('.node-code.code-block');
  await expect(block).toHaveClass(/code-tall/);
  await expect(block).not.toHaveClass(/code-expanded/);
  await expect(block.locator('.code-expand')).toHaveText('Expand code');

  await block.locator('.code-expand').click();
  await expect(block).toHaveClass(/code-expanded/);
  await expect(block.locator('.code-expand')).toHaveText('Collapse code');
  expect(
    await page.evaluate(() =>
      (window as never as { __state?: { expandedCodeKeys?: string[] } }).__state?.expandedCodeKeys,
    ),
  ).toContain('node:a');

  await block.locator('.code-expand').click();
  await block.locator('textarea.code-input').click();
  await expect(block).toHaveClass(/code-expanded/);
});

test('打字时高亮跟着更新（只重画高亮层，不重建代码块）', async ({ page }) => {
  await openOutline(page, [fence('```ts\nconst n = 1;\n```')]);
  const area = page.locator('textarea.code-input');
  await area.click();
  await area.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await page.keyboard.type('\nfunction g() {}');

  await expect(page.locator('.code-hl .token.keyword')).toHaveCount(2); // const + function
  await expect(area).toBeFocused(); // 没被重建打断
});

test('复制按钮把代码原文发给宿主写剪贴板（copyText），并给出「已复制」反馈', async ({ page }) => {
  await openOutline(page, [fence(TS)]);
  await clearPosted(page);

  const btn = page.locator('.code-copy');
  await expect(btn).toHaveText('Copy');
  await btn.click();

  const copied = (await posted(page)).filter((m) => m.type === 'copyText');
  expect(copied).toEqual([{ type: 'copyText', text: 'const n = 42; // 注释' }]);
  await expect(btn).toHaveText('Copied');
});

test('复制按钮平时不显形，hover 代码块才出现', async ({ page }) => {
  await openOutline(page, [fence(TS), node('b', 'other')]);
  const btn = page.locator('.code-copy');
  expect(await btn.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');

  await page.locator('.node[data-id="a"] .node-code').hover();
  expect(await btn.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
});


// 围栏行被渲染层摘掉了，语言只活在 data-code-open 里：不给入口就永远改不了（实机反馈）。
test('点语言徽标切换语言：重写围栏开行、重画高亮，围栏字符与缩进不动', async ({ page }) => {
  await openOutline(page, [fence('```ts\nprint(1)\n```')]);
  await page.locator('.code-lang').click();
  await expect(page.locator('.lang-menu')).toBeVisible();
  // 当前语言打勾
  await expect(page.locator('.lang-menu .context-menu-item.current')).toHaveText('TypeScript');

  await clearPosted(page);
  await page.locator('.lang-menu .context-menu-item', { hasText: 'Python' }).click();
  await expect(page.locator('.lang-menu')).toHaveCount(0);
  await expect(page.locator('.code-lang')).toHaveText('python');

  await inject(page, { type: 'ack', seq: 1, version: 2 });
  await page.waitForFunction(() =>
    (window as never as { __posted: { type: string; ops?: { op: string; note?: string }[] }[] }).__posted.some(
      (m) => m.type === 'edit' && (m.ops ?? []).some((o) => o.op === 'setNote' && o.note?.startsWith('```python')),
    ),
  );
});

test('波浪号围栏切换语言后仍是波浪号（字节保真）', async ({ page }) => {
  await openOutline(page, [fence('~~~~ts\nx\n~~~~')]);
  await page.locator('.code-lang').click();
  await page.locator('.lang-menu .context-menu-item', { hasText: 'Go' }).click();

  const open = await page.locator('.node-code').evaluate((el: HTMLElement) => el.dataset.codeOpen);
  expect(open).toBe('~~~~go');
});

// 代码 textarea 内 Tab 仍沿用大纲层级语义，焦点留在当前代码块。
test('节点代码块里 Tab / Shift+Tab 缩进的是节点本身，焦点留在代码里', async ({ page }) => {
  await openOutline(page, [
    node('x', '前一个兄弟'),
    { id: 'a', text: '', note: '```ts\nconst a = 1;\n```', children: [] },
  ]);
  const area = page.locator('.node[data-id="a"] textarea.code-input');
  await area.click();
  await page.keyboard.press('Tab');

  await expect(page.locator('.node[data-id="x"] > .children > .node[data-id="a"]')).toHaveCount(1);
  await expect(page.locator('.node[data-id="a"] textarea.code-input')).toBeFocused();
  await expect(area).toHaveValue('const a = 1;'); // 没往代码里插东西

  await inject(page, { type: 'ack', seq: 1, version: 2 });
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.list-block > .node[data-id="a"]')).toHaveCount(1);
});

test('代码块头部不额外撑高代码块', async ({ page }) => {
  await openOutline(page, [{ id: 'a', text: '标题', note: '```ts\nx\n```', children: [] }]);
  const geom = await page.evaluate(() => {
    const box = (sel: string): DOMRect => document.querySelector(sel)!.getBoundingClientRect();
    return { body: box('.node[data-id="a"] .code-body').height, code: box('.node[data-id="a"] .node-code').height };
  });
  expect(geom.code - geom.body).toBeLessThanOrEqual(8);
});

test('旧文档空标题代码块按 Esc 回到自身必填标题行', async ({ page }) => {
  await openOutline(page, [
    node('b', '上一个节点'),
    { id: 'a', text: '', note: '```ts\nx\n```', children: [] },
    node('c', '下一个节点'),
  ]);
  await page.locator('.node[data-id="a"] textarea.code-input').click();
  await page.keyboard.press('Escape');

  const at = await page.evaluate(() => ({
    node: document.activeElement?.closest('.node')?.getAttribute('data-id'),
    field: document.activeElement?.getAttribute('data-field'),
  }));
  expect(at).toEqual({ node: 'a', field: 'text' });
});

test('正文有字的代码块节点，Esc 仍回本节点正文', async ({ page }) => {
  await openOutline(page, [node('b', '上一个'), fence('```ts\nx\n```')]);
  await page.locator('.node[data-id="a"] textarea.code-input').click();
  await page.keyboard.press('Escape');

  const at = await page.evaluate(() => ({
    node: document.activeElement?.closest('.node')?.getAttribute('data-id'),
    field: document.activeElement?.getAttribute('data-field'),
  }));
  expect(at).toEqual({ node: 'a', field: 'text' });
});

test('空标题获得焦点时标题行仍在代码块上方并对齐内容列', async ({ page }) => {
  await openOutline(page, [
    node('b', '上一个节点'),
    { id: 'a', text: '', note: '```ts\nx\n```', children: [] },
  ]);
  await page.locator('.node[data-id="b"] [data-field="text"]').click();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.node[data-id="a"] > .node-row > [data-field="text"]')).toBeFocused();

  const geom = await page.evaluate(() => {
    const box = (sel: string): DOMRect => document.querySelector(sel)!.getBoundingClientRect();
    const text = box('.node[data-id="a"] > .node-row > [data-field="text"]');
    const code = box('.node[data-id="a"] .node-code');
    return { textX: text.x, textBottom: text.bottom, codeX: code.x, codeY: code.y };
  });
  expect(geom.codeY).toBeGreaterThanOrEqual(geom.textBottom - 2);
  expect(Math.abs(geom.codeX - geom.textX)).toBeLessThanOrEqual(4); // 与正文左缘对齐
});
