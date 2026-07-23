// M4：搜索过滤、pointer 拖拽、剪贴板。
import { expect, test, type Page } from '@playwright/test';
import {
  caretState,
  clearPosted,
  focusText,
  node,
  openOutline,
  posted,
  textsInDom,
  waitForEdit,
} from './support.js';

const visibleTexts = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.node')]
      .filter((el) => !el.classList.contains('hidden'))
      .map((el) => el.querySelector('[data-field="text"]')?.textContent ?? ''),
  );

test('搜索：命中节点与祖先链保留，其余只加 class 不动 DOM', async ({ page }) => {
  await openOutline(page, [
    node('a', '工作', [node('a1', '写周报'), node('a2', '开会')]),
    node('b', '生活', [node('b1', '买菜')]),
  ]);

  const domCount = await page.locator('.node').count();
  await page.locator('.search-input').fill('周报');
  await expect(page.locator('.node.hidden')).toHaveCount(3);

  expect(await visibleTexts(page)).toEqual(['工作', '写周报']); // 祖先链保留
  expect(await page.locator('.node').count()).toBe(domCount); // DOM 结构没动
  await expect(page.locator('.node[data-id="a1"]')).toHaveClass(/search-hit/);

  await page.locator('.search-input').fill('');
  await expect(page.locator('.node.hidden')).toHaveCount(0);
  expect(await visibleTexts(page)).toEqual(['工作', '写周报', '开会', '生活', '买菜']);
});

test('搜索：命中 note，且能穿透折叠子树', async ({ page }) => {
  await openOutline(page, [
    { id: 'a', text: '父节点', children: [{ id: 'a1', text: '子节点', note: '藏在备注里的关键词' }] },
    node('b', '别的'),
  ]);
  await page.locator('.node[data-id="a"] > .node-row > .toggle').click();
  expect(await textsInDom(page)).toEqual(['父节点', '别的']); // 已折叠

  await page.locator('.search-input').fill('关键词');
  // 折叠的子节点为了搜索被挂载出来
  await expect(page.locator('.node[data-id="a1"]')).toHaveClass(/search-hit/);
  expect(await visibleTexts(page)).toEqual(['父节点', '子节点']);

  // 清空搜索后折叠状态恢复原样
  await page.locator('.search-input').fill('');
  await expect(page.locator('.node[data-id="a1"]')).toHaveCount(0);
  expect(await textsInDom(page)).toEqual(['父节点', '别的']);
});

test('Cmd/Ctrl+F 聚焦搜索框，Esc 清空', async ({ page }) => {
  await openOutline(page, [node('a', 'alpha')]);
  await focusText(page, 'a', 0);
  await page.keyboard.press('ControlOrMeta+f');
  expect(await page.evaluate(() => document.activeElement?.className)).toBe('search-input');

  await page.keyboard.type('alp');
  await expect(page.locator('.node[data-id="a"]')).toHaveClass(/search-hit/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.node[data-id="a"]')).not.toHaveClass(/search-hit/);
});

/** 用 pointer 事件把某个节点的 bullet 拖到目标行的下沿。 */
async function dragBullet(
  page: Page,
  fromId: string,
  toId: string,
  opts: { depth?: number } = {},
): Promise<void> {
  const from = await page.locator(`.node[data-id="${fromId}"] > .node-row > .bullet`).boundingBox();
  const to = await page.locator(`.node[data-id="${toId}"] > .node-row`).boundingBox();
  if (!from || !to) throw new Error('missing element');
  const indent = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--outline-indent')),
  );
  const rootLeft = (await page.locator('#outline-root').boundingBox())!.x;
  const targetX = rootLeft + ((opts.depth ?? 0) + 1) * indent;

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 10, { steps: 2 });
  await page.mouse.move(targetX, to.y + to.height - 2, { steps: 4 });
  await page.mouse.up();
}

test('拖拽：拖到另一节点下方成为其子节点，发出单条 move op', async ({ page }) => {
  await openOutline(page, [node('a', 'alpha'), node('b', 'beta'), node('c', 'gamma')]);
  await clearPosted(page);

  await dragBullet(page, 'c', 'a', { depth: 1 });

  const edit = await waitForEdit(page);
  expect(edit.ops).toEqual([{ op: 'move', id: 'c', parentId: 'a', index: 0 }]);
  await expect(page.locator('.node[data-id="a"] > .children > .node[data-id="c"]')).toHaveCount(1);
});

test('拖拽：同层重排（水平偏移决定深度）', async ({ page }) => {
  await openOutline(page, [node('a', 'alpha'), node('b', 'beta'), node('c', 'gamma')]);
  await clearPosted(page);

  await dragBullet(page, 'c', 'a', { depth: 0 });

  const edit = await waitForEdit(page);
  expect(edit.ops).toEqual([{ op: 'move', id: 'c', parentId: null, index: 1 }]);
  expect(await textsInDom(page)).toEqual(['alpha', 'gamma', 'beta']);
});

test('拖拽：Esc 取消，不产生任何 op', async ({ page }) => {
  await openOutline(page, [node('a', 'alpha'), node('b', 'beta')]);
  await clearPosted(page);

  const from = (await page.locator('.node[data-id="b"] > .node-row > .bullet').boundingBox())!;
  const to = (await page.locator('.node[data-id="a"] > .node-row').boundingBox())!;
  await page.mouse.move(from.x + 4, from.y + 8);
  await page.mouse.down();
  await page.mouse.move(to.x + 40, to.y + 4, { steps: 4 });
  await expect(page.locator('.drop-indicator')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.up();

  await page.waitForTimeout(300);
  expect(await posted(page)).toEqual([]);
  expect(await textsInDom(page)).toEqual(['alpha', 'beta']);
});

test('拖拽：不能把节点拖进自己的子树（无落点）', async ({ page }) => {
  await openOutline(page, [node('a', 'alpha', [node('a1', 'child')])]);
  await clearPosted(page);

  await dragBullet(page, 'a', 'a1', { depth: 2 });
  await page.waitForTimeout(300);

  const moves = (await posted(page)).filter((m) => m.type === 'edit');
  expect(moves).toEqual([]);
  expect(await textsInDom(page)).toEqual(['alpha', 'child']);
});

test('粘贴：Workflowy 导出的缩进列表还原层级', async ({ page }) => {
  await openOutline(page, [node('a', '原有节点')]);
  await clearPosted(page);
  await focusText(page, 'a', 4);

  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', '- 一级\n  - 二级\n    - 三级\n- 另一个一级');
    document
      .querySelector('.node[data-id="a"] [data-field="text"]')!
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });

  const edit = await waitForEdit(page);
  const op = (edit.ops as Record<string, unknown>[])[0];
  expect(op).toMatchObject({ op: 'insertSubtree', parentId: null, index: 1 });
  expect(await textsInDom(page)).toEqual(['原有节点', '一级', '二级', '三级', '另一个一级']);
  await expect(page.locator('.node[data-id="a"] ~ .node .node .node')).toHaveCount(1);
});

test('粘贴：无列表语法的多行文本按行拆成兄弟节点', async ({ page }) => {
  await openOutline(page, [node('a', '')]);
  await clearPosted(page);
  await focusText(page, 'a', 0);

  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', '第一行\n第二行\n第三行');
    document
      .querySelector('.node[data-id="a"] [data-field="text"]')!
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });

  await waitForEdit(page);
  // 空节点被收掉（本地乐观更新已生效）
  expect(await textsInDom(page)).toEqual(['第一行', '第二行', '第三行']);
});

test('复制：光标所在节点的整棵子树序列化为 markdown', async ({ page }) => {
  await openOutline(page, [
    { id: 'a', text: '父', note: '备注', children: [node('a1', '子'), { id: 'a2', text: '完成项', checked: true }] },
  ]);
  await focusText(page, 'a', 1);

  const copied = await page.evaluate(() => {
    const data = new DataTransfer();
    const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
    document.querySelector('.node[data-id="a"] [data-field="text"]')!.dispatchEvent(event);
    return data.getData('text/plain');
  });

  expect(copied).toBe('- 父\n  备注\n  - 子\n  - [x] 完成项\n');
});

test('剪切：复制子树并删除节点', async ({ page }) => {
  await openOutline(page, [node('a', 'keep'), node('b', 'cut me', [node('b1', 'child')])]);
  await clearPosted(page);
  await focusText(page, 'b', 0);

  const copied = await page.evaluate(() => {
    const data = new DataTransfer();
    const event = new ClipboardEvent('cut', { clipboardData: data, bubbles: true, cancelable: true });
    document.querySelector('.node[data-id="b"] [data-field="text"]')!.dispatchEvent(event);
    return data.getData('text/plain');
  });

  expect(copied).toBe('- cut me\n  - child\n');
  expect((await waitForEdit(page)).ops).toEqual([{ op: 'delete', id: 'b' }]);
  expect(await textsInDom(page)).toEqual(['keep']);
  expect(await caretState(page)).toEqual({ id: 'a', offset: 4 });
});
