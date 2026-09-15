import { test, expect } from '@playwright/test';
import { openOutline, focusText, node, inject, snapshot } from './support.js';

test('divider render, title edit, cancel and children survive', async ({ page }) => {
  await openOutline(page, [node('a', '***'), { ...node('b', '标题', [node('c', 'child')]), note: '***' }]);
  await expect(page.locator('.divider-plain')).toHaveCount(1);
  await expect(page.locator('.divider-title')).toHaveCount(1);
  await expect(page.locator('.node[data-id="b"] > .note')).toHaveCount(0);
  await focusText(page, 'b', 2);
  await page.keyboard.insertText('中文');
  await expect(page.locator('.node[data-id="b"] > .node-row > .text')).toHaveText('标题中文');
  await focusText(page, 'b', 0);
  await page.keyboard.press('Backspace');
  await expect(page.locator('.node[data-id="b"] > .node-row')).not.toHaveClass(/divider/);
  await expect(page.locator('.node[data-id="c"]')).toHaveCount(1);
});

test('slash creates titled divider and Enter inserts sibling', async ({ page }) => {
  await openOutline(page, [node('a', 'Section ', [node('c', 'child')]), node('b', 'after')]);
  await focusText(page, 'a', 8);
  await page.keyboard.type('/divider');
  await page.keyboard.press('Enter');
  await expect(page.locator('.divider-title')).toHaveCount(1);
  await expect(page.locator('.node[data-id="a"] > .node-row > .text')).toHaveText('Section');
  await page.keyboard.press('Enter');
  await expect(page.locator('.list-block > .node')).toHaveCount(3);
  await expect(page.locator('.node[data-id="a"] > .children > .node')).toHaveCount(1);
});

test('shortcut, add title, external refresh', async ({ page }) => {
  await openOutline(page, [node('a', '')]);
  await focusText(page, 'a', 0);
  await page.keyboard.type('---');
  await page.keyboard.press('Enter');
  await expect(page.locator('.divider-plain')).toHaveCount(1);
  await page.locator('.divider-plain').hover();
  await page.getByRole('button', { name: 'Add title' }).click();
  await page.keyboard.insertText('New title');
  await expect(page.locator('.divider-title > .text')).toHaveText('New title');
  await page.locator('.search-input').focus();
  await inject(page, { type: 'refresh', version: 10, cause: 'external', snapshot: snapshot([{ ...node('a', 'External'), note: '***' }]) });
  await expect(page.locator('.divider-title > .text')).toHaveText('External');
});

test('IME title composition preserves the divider editor', async ({ page }) => {
  await openOutline(page, [node('a', '***'), { ...node('b', '带标题的'), note: '***' }, node('c', 'Next')]);
  await focusText(page, 'b', 4);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
  await expect(page.locator('.divider-title > .text')).toHaveText('带标题的中文');
  await cdp.send('Input.insertText', { text: '中文' });
  await expect(page.locator('.divider-title > .text')).toHaveText('带标题的中文');
  await page.locator('.search-input').focus();
});

test('existing note is protected', async ({ page }) => {
  await openOutline(page, [{ ...node('a', ''), note: 'keep me' }]);
  await focusText(page, 'a', 0);
  await page.keyboard.type('/divider');
  await expect(page.locator('.slash-item')).toHaveCount(0);
  await expect(page.locator('.note')).toHaveText('keep me');
});

test('typing stars into a note does not remove its focused editor', async ({ page }) => {
  await openOutline(page, [{ ...node('a', 'Title'), note: '' }]);
  const noteEditor = page.locator('.node[data-id="a"] > .note');
  await noteEditor.focus();
  await page.keyboard.type('***');
  await expect(noteEditor).toBeFocused();
  await page.keyboard.type(' still a note');
  await expect(noteEditor).toHaveText('*** still a note');
  await page.locator('.search-input').focus();
  await expect(page.locator('.divider')).toHaveCount(0);
});
