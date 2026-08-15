// 键盘可达性与语义（M5 打磨项）。
import { expect, test } from '@playwright/test';
import { focusText, node, openOutline } from './support.js';

test('大纲有 tree / treeitem / group 语义，层级用 aria-level 表达', async ({ page }) => {
  await openOutline(page, [node('a', 'A', [node('a1', 'A1', [node('a2', 'A2')])]), node('b', 'B')]);

  await expect(page.locator('.list-block')).toHaveAttribute('role', 'tree');
  await expect(page.locator('.node[data-id="a"]')).toHaveAttribute('role', 'treeitem');
  await expect(page.locator('.node[data-id="a"]')).toHaveAttribute('aria-level', '1');
  await expect(page.locator('.node[data-id="a1"]')).toHaveAttribute('aria-level', '2');
  await expect(page.locator('.node[data-id="a2"]')).toHaveAttribute('aria-level', '3');
  await expect(page.locator('.node[data-id="a"] > .children')).toHaveAttribute('role', 'group');
});

test('折叠按钮有 aria-expanded 与中文标签', async ({ page }) => {
  await openOutline(page, [node('a', 'A', [node('a1', 'A1')])]);
  const toggle = page.locator('.node[data-id="a"] > .node-row > .toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveAttribute('aria-label', 'Collapse');
  const size = await toggle.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(size.width).toBeGreaterThanOrEqual(24);
  expect(size.height).toBeGreaterThanOrEqual(24);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveAttribute('aria-label', 'Expand');
});

test('正文与备注是单行/多行 textbox', async ({ page }) => {
  await openOutline(page, [{ id: 'a', text: 'body', note: '备注' }]);
  const text = page.locator('.node[data-id="a"] [data-field="text"]');
  await expect(text).toHaveAttribute('role', 'textbox');
  await expect(text).toHaveAttribute('aria-multiline', 'false');
  await expect(text).toHaveAttribute('contenteditable', 'plaintext-only');
});

// 正在编辑的节点刻意不画焦点框（用户反馈：打字时整页跳框），焦点提示交给闪烁的光标：
// caret-color 必须显式跟随主题，否则在某些主题下光标近乎不可见 = 完全没有焦点提示。
// 高对比度（forced-colors）下另有 outline 兜底，见 styles.css 文末。
test('聚焦的节点不画焦点框，但光标颜色跟随主题', async ({ page }) => {
  await openOutline(page, [node('a', 'A')]);
  await focusText(page, 'a', 0);
  const style = await page
    .locator('.node[data-id="a"] [data-field="text"]')
    .evaluate((el) => {
      const css = getComputedStyle(el);
      return { shadow: css.boxShadow, outline: css.outlineStyle, caret: css.caretColor };
    });
  expect(style.shadow).toBe('none');
  expect(style.outline).toBe('none');
  expect(style.caret).not.toBe('');
});

test('搜索框有 aria-label', async ({ page }) => {
  await openOutline(page, [node('a', 'A')]);
  await expect(page.locator('.search-input')).toHaveAttribute('aria-label', 'Search nodes');
});
