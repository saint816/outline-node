// 代码块的语法高亮 + 复制按钮。高亮层是 textarea 背后的 <pre>，两层必须严格对齐，
// 否则整块代码「重影」；复制走宿主剪贴板（webview 里的浏览器剪贴板 API 有静默失败前科）。
import { expect, test, type Page } from '@playwright/test';
import { clearPosted, node, openOutline, posted } from './support.js';

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
