// 节点多选（selection.ts）：Shift+↑↓ / Shift+点击 建选区，Tab / Alt+↑↓ / Cmd+Enter /
// Backspace 批量生效，且一次批量只发一条 edit（= 一个 undo 步）。
import { expect, test, type Page } from '@playwright/test';
import { clearPosted, focusText, inject, node, openOutline, posted, textsInDom } from './support.js';

/** 当前打了 .selected 的节点 id（文档顺序）。 */
async function selectedIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.node.selected')].map((el) => el.getAttribute('data-id') ?? ''),
  );
}

/** 最后一条 edit 消息里的 op 名列表。 */
async function lastEditOps(page: Page): Promise<string[]> {
  const all = await posted(page);
  const edit = all.filter((m) => m.type === 'edit').at(-1) as { ops?: { op: string }[] } | undefined;
  return (edit?.ops ?? []).map((o) => o.op);
}

test('Shift+↓ 从光标所在节点进入多选，再按继续扩选', async ({ page }) => {
  await openOutline(page, [node('a', 'A'), node('b', 'B'), node('c', 'C')]);
  await focusText(page, 'a', 1);

  await page.keyboard.press('Shift+ArrowDown');
  expect(await selectedIds(page)).toEqual(['a', 'b']);

  await page.keyboard.press('Shift+ArrowDown');
  expect(await selectedIds(page)).toEqual(['a', 'b', 'c']);

  // 反向收回
  await page.keyboard.press('Shift+ArrowUp');
  expect(await selectedIds(page)).toEqual(['a', 'b']);
});

test('Shift+↑ 反向多选；Esc 退出', async ({ page }) => {
  await openOutline(page, [node('a', 'A'), node('b', 'B')]);
  await focusText(page, 'b', 0);

  await page.keyboard.press('Shift+ArrowUp');
  expect(await selectedIds(page)).toEqual(['a', 'b']);

  await page.keyboard.press('Escape');
  expect(await selectedIds(page)).toEqual([]);
});

test('Shift+点击另一个节点选中区间（同节点内不抢文本选区）', async ({ page }) => {
  await openOutline(page, [node('a', 'A'), node('b', 'B'), node('c', 'C')]);
  await focusText(page, 'a', 0);

  // 同一节点上的 Shift+点击不进入多选
  await page.locator('.node[data-id="a"] > .node-row > [data-field="text"]').click({
    modifiers: ['Shift'],
  });
  expect(await selectedIds(page)).toEqual([]);

  await page.locator('.node[data-id="c"] > .node-row > [data-field="text"]').click({
    modifiers: ['Shift'],
  });
  expect(await selectedIds(page)).toEqual(['a', 'b', 'c']);

  // Shift+点击 bullet 只选区间，不会顺手 zoom 进去
  await page.locator('.node[data-id="b"] > .node-row > .bullet').click({ modifiers: ['Shift'] });
  expect(await selectedIds(page)).toEqual(['a', 'b']);
  await expect(page.locator('.breadcrumb .crumb')).toHaveCount(0);

  // 普通点击退出多选
  await page.locator('.node[data-id="b"] > .node-row > [data-field="text"]').click();
  expect(await selectedIds(page)).toEqual([]);
});

test('选中子树时只高亮子树根（后代被吸收，批量 op 不重复施加）', async ({ page }) => {
  await openOutline(page, [node('a', 'A', [node('a1', 'A1')]), node('b', 'B')]);
  await focusText(page, 'a', 0);

  await page.keyboard.press('Shift+ArrowDown'); // a + a1
  expect(await selectedIds(page)).toEqual(['a']);

  await page.keyboard.press('Shift+ArrowDown'); // a + a1 + b
  expect(await selectedIds(page)).toEqual(['a', 'b']);
});

test('Tab 批量缩进：两个节点一起挪到前一个兄弟下，只发一条 edit', async ({ page }) => {
  await openOutline(page, [node('x', 'X'), node('a', 'A'), node('b', 'B')]);
  await focusText(page, 'a', 0);
  await page.keyboard.press('Shift+ArrowDown');
  await clearPosted(page);

  await page.keyboard.press('Tab');
  await expect(page.locator('.node[data-id="x"] > .children > .node[data-id="a"]')).toHaveCount(1);
  await expect(page.locator('.node[data-id="x"] > .children > .node[data-id="b"]')).toHaveCount(1);
  expect(await textsInDom(page)).toEqual(['X', 'A', 'B']); // 相对顺序不变

  // 一次批量 = 一条 edit（= 一个 VS Code undo 步）
  const edits = (await posted(page)).filter((m) => m.type === 'edit');
  expect(edits).toHaveLength(1);
  expect(await lastEditOps(page)).toEqual(['indent', 'indent']);
});

test('Shift+Tab 批量反缩进保持相对顺序（逆序施加）', async ({ page }) => {
  await openOutline(page, [node('x', 'X', [node('a', 'A'), node('b', 'B')]), node('y', 'Y')]);
  await focusText(page, 'a', 0);
  await page.keyboard.press('Shift+ArrowDown');
  await clearPosted(page);

  await page.keyboard.press('Shift+Tab');
  expect(await textsInDom(page)).toEqual(['X', 'A', 'B', 'Y']);
  await expect(page.locator('.list-block > .node[data-id="a"]')).toHaveCount(1);
  await expect(page.locator('.list-block > .node[data-id="b"]')).toHaveCount(1);
  expect(await lastEditOps(page)).toEqual(['outdent', 'outdent']);
});

test('Alt+↓ / Alt+↑ 批量移动，选区跟着走', async ({ page }) => {
  await openOutline(page, [node('a', 'A'), node('b', 'B'), node('c', 'C')]);
  await focusText(page, 'a', 0);
  await page.keyboard.press('Shift+ArrowDown'); // a + b
  await clearPosted(page);

  await page.keyboard.press('Alt+ArrowDown');
  expect(await textsInDom(page)).toEqual(['C', 'A', 'B']);
  expect(await lastEditOps(page)).toEqual(['moveDown', 'moveDown']);
  expect(await selectedIds(page)).toEqual(['a', 'b']);

  await inject(page, { type: 'ack', seq: 1, version: 2 });
  await page.keyboard.press('Alt+ArrowUp');
  expect(await textsInDom(page)).toEqual(['A', 'B', 'C']);
});

test('Cmd/Ctrl+Enter 批量完成，再按批量取消', async ({ page }) => {
  await openOutline(page, [node('a', 'A'), node('b', 'B')]);
  await focusText(page, 'a', 0);
  await page.keyboard.press('Shift+ArrowDown');
  await clearPosted(page);

  await page.keyboard.press('Control+Enter');
  await expect(page.locator('.node[data-id="a"] > .node-row')).toHaveClass(/checked/);
  await expect(page.locator('.node[data-id="b"] > .node-row')).toHaveClass(/checked/);
  expect(await lastEditOps(page)).toEqual(['setChecked', 'setChecked']);

  await inject(page, { type: 'ack', seq: 1, version: 2 });
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('.node[data-id="a"] > .node-row')).not.toHaveClass(/checked/);
  await expect(page.locator('.node[data-id="b"] > .node-row')).not.toHaveClass(/checked/);
});

test('Backspace 批量删除整段（含子树），光标落到选区前一行', async ({ page }) => {
  await openOutline(page, [
    node('x', 'X'),
    node('a', 'A', [node('a1', 'A1')]),
    node('b', 'B'),
    node('c', 'C'),
  ]);
  await focusText(page, 'a', 0);
  await page.keyboard.press('Shift+ArrowDown'); // a（吸收 a1）
  await page.keyboard.press('Shift+ArrowDown'); // + b
  await clearPosted(page);

  await page.keyboard.press('Backspace');
  await expect(page.locator('.confirm-dialog')).toBeVisible();
  // 取消不应破坏现有多选；再次删除并确认。
  await page.locator('.confirm-cancel').click();
  expect(await selectedIds(page)).toEqual(['a', 'b']);
  await page.keyboard.press('Backspace');
  await page.locator('.confirm-delete').click();
  expect(await textsInDom(page)).toEqual(['X', 'C']);
  expect(await lastEditOps(page)).toEqual(['delete', 'delete']);
  expect(await selectedIds(page)).toEqual([]);

  const focused = await page.evaluate(
    () => document.activeElement?.closest('.node')?.getAttribute('data-id') ?? null,
  );
  expect(focused).toBe('x');
});

test('打字退出多选（不误删选中节点）', async ({ page }) => {
  await openOutline(page, [node('a', 'A'), node('b', 'B')]);
  await focusText(page, 'a', 1);
  await page.keyboard.press('Shift+ArrowDown');
  expect(await selectedIds(page)).toEqual(['a', 'b']);

  await page.keyboard.type('!');
  expect(await selectedIds(page)).toEqual([]);
  expect(await textsInDom(page)).toEqual(['A!', 'B']);
});

test('多选复制：整段序列化成一份 markdown 列表', async ({ page }) => {
  await openOutline(page, [node('a', 'A', [node('a1', 'A1')]), node('b', 'B'), node('c', 'C')]);
  await focusText(page, 'a', 0);
  await page.keyboard.press('Shift+ArrowDown'); // a（含 a1）
  await page.keyboard.press('Shift+ArrowDown'); // + b

  // 合成 copy 事件，读回写进剪贴板的文本（真剪贴板在 headless 下不可靠）
  const copied = await page.evaluate(() => {
    const dt = new DataTransfer();
    const el = document.querySelector('.node[data-id="a"] [data-field="text"]') as HTMLElement;
    el.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }),
    );
    return dt.getData('text/plain');
  });
  expect(copied).toBe('- A\n  - A1\n- B\n');
});
