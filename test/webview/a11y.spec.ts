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

test('聚焦的节点有可见的 focus 环', async ({ page }) => {
  await openOutline(page, [node('a', 'A')]);
  await focusText(page, 'a', 0);
  const shadow = await page
    .locator('.node[data-id="a"] [data-field="text"]')
    .evaluate((el) => getComputedStyle(el).boxShadow);
  expect(shadow).not.toBe('none');
});

test('搜索框有 aria-label', async ({ page }) => {
  await openOutline(page, [node('a', 'A')]);
  await expect(page.locator('.search-input')).toHaveAttribute('aria-label', 'Search nodes');
});
