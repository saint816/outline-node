// M3 大纲功能：折叠、Alt+↑↓、完成态、note、zoom + 面包屑。
import { expect, test } from '@playwright/test';
import {
  caretState,
  clearPosted,
  focusText,
  inject,
  node,
  openOutline,
  posted,
  snapshot,
  textsInDom,
  waitForEdit,
} from './support.js';

test('折叠：子树不在 DOM 里，展开后回来', async ({ page }) => {
  await openOutline(page, [node('a', 'parent', [node('a1', 'child', [node('a2', 'grand')])])]);

  await page.locator('.node[data-id="a"] > .node-row > .toggle').click();
  expect(await textsInDom(page)).toEqual(['parent']);
  await expect(page.locator('.node[data-id="a1"]')).toHaveCount(0); // 不是 display:none，是根本不构建
  await expect(page.locator('.node[data-id="a"] > .node-row > .toggle')).toHaveAttribute(
    'aria-expanded',
    'false',
  );

  await page.locator('.node[data-id="a"] > .node-row > .toggle').click();
  expect(await textsInDom(page)).toEqual(['parent', 'child', 'grand']);
});

test('折叠状态节流上报 saveFolding，用的是 nodeKey 不是 id', async ({ page }) => {
  await openOutline(page, [node('a', 'parent', [node('a1', 'child')]), node('b', 'other')]);
  await clearPosted(page);

  await page.locator('.node[data-id="a"] > .node-row > .toggle').click();
  await page.waitForFunction(
    () => (window as never as { __posted: { type: string }[] }).__posted.some((m) => m.type === 'saveFolding'),
    undefined,
    { timeout: 5000 },
  );

  const msg = (await posted(page)).find((m) => m.type === 'saveFolding')!;
  const keys = msg.foldedKeys as string[];
  expect(keys).toHaveLength(1);
  expect(keys[0]).toMatch(/^h:[0-9a-z]+$/); // 文本哈希，不含 id
});

test('init 下发的 foldedKeys 按 nodeKey 反查节点', async ({ page }) => {
  // 'parent' 的 key 由 core/nodeKey 计算；这里先跑一遍拿到它，再用它重开
  await openOutline(page, [node('a', 'parent', [node('a1', 'child')])]);
  await page.locator('.node[data-id="a"] > .node-row > .toggle').click();
  await page.waitForFunction(
    () => (window as never as { __posted: { type: string }[] }).__posted.some((m) => m.type === 'saveFolding'),
    undefined,
    { timeout: 5000 },
  );
  const key = ((await posted(page)).find((m) => m.type === 'saveFolding')!.foldedKeys as string[])[0];

  // 重开：换成不同的 id，同样的文本 → 折叠必须存活
  await openOutline(page, [node('x9', 'parent', [node('x8', 'child')])]);
  await inject(page, {
    type: 'init',
    snapshot: snapshot([node('x9', 'parent', [node('x8', 'child')])]),
    version: 1,
    foldedKeys: [key],
    config: { defaultIndent: { kind: 'space', width: 2 }, defaultFold: 'none', rememberFolding: true },
  });
  await expect(page.locator('.node[data-id="x8"]')).toHaveCount(0);
});

test('defaultFold=firstLevel：无记录时首层折叠', async ({ page }) => {
  await openOutline(page, [node('a', 'A', [node('a1', 'A1')]), node('b', 'B', [node('b1', 'B1')])]);
  await inject(page, {
    type: 'init',
    snapshot: snapshot([node('a', 'A', [node('a1', 'A1')]), node('b', 'B', [node('b1', 'B1')])]),
    version: 1,
    foldedKeys: [],
    config: {
      defaultIndent: { kind: 'space', width: 2 },
      defaultFold: 'firstLevel',
      rememberFolding: true,
    },
  });
  expect(await textsInDom(page)).toEqual(['A', 'B']);
});

test('折叠节点上回车不再新建子节点，而是拆分', async ({ page }) => {
  await openOutline(page, [node('a', 'parent', [node('a1', 'child')])]);
  await page.locator('.node[data-id="a"] > .node-row > .toggle').click();
  await clearPosted(page);

  await focusText(page, 'a', 6);
  await page.keyboard.press('Enter');
  const edit = await waitForEdit(page);
  expect((edit.ops as Record<string, unknown>[])[0]).toMatchObject({ op: 'split', id: 'a' });
});

test('Alt+↑ / Alt+↓ 移动节点，光标跟随', async ({ page }) => {
  await openOutline(page, [node('a', 'first'), node('b', 'second')]);
  await clearPosted(page);

  await focusText(page, 'b', 2);
  await page.keyboard.press('Alt+ArrowUp');

  const edit = await waitForEdit(page);
  expect(edit.ops).toEqual([{ op: 'moveUp', id: 'b' }]);
  expect(await textsInDom(page)).toEqual(['second', 'first']);
  expect(await caretState(page)).toEqual({ id: 'b', offset: 2 });

  await inject(page, { type: 'ack', seq: 1, version: 2 });
  await clearPosted(page);
  await page.keyboard.press('Alt+ArrowDown');
  expect((await waitForEdit(page)).ops).toEqual([{ op: 'moveDown', id: 'b' }]);
  expect(await textsInDom(page)).toEqual(['first', 'second']);
});

test('Cmd/Ctrl+Enter 切换完成态并加删除线样式', async ({ page }) => {
  await openOutline(page, [node('a', 'task')]);
  await clearPosted(page);

  await focusText(page, 'a', 0);
  await page.keyboard.press('ControlOrMeta+Enter');

  expect((await waitForEdit(page)).ops).toEqual([{ op: 'toggleChecked', id: 'a' }]);
  await expect(page.locator('.node[data-id="a"] > .node-row')).toHaveClass(/checked/);
  const decoration = await page
    .locator('.node[data-id="a"] [data-field="text"]')
    .evaluate((el) => getComputedStyle(el).textDecorationLine);
  expect(decoration).toContain('line-through');
});

test('Shift+Enter 创建 note 并聚焦，note 内换行保留', async ({ page }) => {
  await openOutline(page, [node('a', 'has note')]);
  await clearPosted(page);

  await focusText(page, 'a', 8);
  await page.keyboard.press('Shift+Enter');
  let edit = await waitForEdit(page);
  expect(edit.ops).toEqual([{ op: 'setNote', id: 'a', note: '' }]);
  await expect(page.locator('.node[data-id="a"] > .note')).toHaveCount(1);
  expect(await caretState(page)).toEqual({ id: 'a', offset: 0 });

  await inject(page, { type: 'ack', seq: 1, version: 2 });
  await page.keyboard.type('第一行');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('第二行');
  // 显式失焦会走产品的 flushPending，避免 CI 负载下依赖 300ms 防抖计时。
  await page.locator('.search-input').focus();

  // 等目标 setNote 落定（防抖），别用固定 sleep。超时给足余量——并行负载下 CPU 争用会拖慢
  // 防抖 flush，短超时会偶发失败（这是等待条件，不是 sleep，达成即返回，不浪费时间）。
  await page.waitForFunction(
    () => {
      const edits = (
        window as never as { __posted: { type: string; ops?: { op: string; note?: string }[] }[] }
      ).__posted.filter((m) => m.type === 'edit');
      const last = edits[edits.length - 1];
      return !!last?.ops?.some((o) => o.op === 'setNote' && o.note === '第一行\n第二行');
    },
    undefined,
    { timeout: 10000 },
  );

  edit = (await posted(page)).filter((m) => m.type === 'edit').at(-1)!;
  expect(edit.ops).toEqual([{ op: 'setNote', id: 'a', note: '第一行\n第二行' }]);
});

test('note 里回车回到正文末尾', async ({ page }) => {
  await openOutline(page, [{ id: 'a', text: 'body', note: '备注' }]);
  await page.locator('.node[data-id="a"] > .note').click();
  await page.keyboard.press('Enter');
  expect(await caretState(page)).toEqual({ id: 'a', offset: 4 });
});

test('输入 note 再清空并失焦 → 空 note 归一为 null，不残留空行、不上报 note:""', async ({ page }) => {
  await openOutline(page, [node('a', 'body')]);
  await focusText(page, 'a', 4);
  await page.keyboard.press('Shift+Enter'); // 创建 note 并聚焦
  await inject(page, { type: 'ack', seq: 1, version: 2 });
  await page.keyboard.type('临时');
  const noteEl = page.locator('.node[data-id="a"] > .note');
  await expect(noteEl).toHaveText('临时');

  // 清空 note 内容
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await expect(noteEl).toHaveText('');
  await clearPosted(page);

  // 焦点移回正文 → note 失焦后应被移除（不再占一行）。移除只可能来自归一的 setNote(null)，
  // 所以 DOM 消失即证明「空 note 归一为 null」发生了 —— 这条红线（不往 .md 写空白行）由此守住。
  await page.locator('.node[data-id="a"] [data-field="text"]').click();
  await expect(page.locator('.node[data-id="a"] > .note')).toHaveCount(0);
});

test('zoom：只渲染子树，面包屑可回退', async ({ page }) => {
  await openOutline(page, [
    node('a', 'A', [node('a1', 'A1', [node('a2', 'A2')])]),
    node('b', 'B'),
  ]);

  // 点 bullet 进入 zoom
  await page.locator('.node[data-id="a1"] > .node-row > .bullet').click();
  expect(await textsInDom(page)).toEqual(['A1', 'A2']);
  await expect(page.locator('.node[data-id="b"]')).toHaveCount(0);
  await expect(page.locator('.breadcrumb .crumb')).toHaveText(['Home', 'A', 'A1']);

  // 面包屑跳回 A（限定在面包屑内：侧栏也有同名 'A' 按钮）
  await page.locator('.breadcrumb').getByRole('button', { name: 'A', exact: true }).click();
  expect(await textsInDom(page)).toEqual(['A', 'A1', 'A2']);

  // Alt+← 再退到全文档
  await focusText(page, 'a1', 0);
  await page.keyboard.press('Alt+ArrowLeft');
  expect(await textsInDom(page)).toEqual(['A', 'A1', 'A2', 'B']);
  await expect(page.locator('.breadcrumb')).toBeHidden();
});

test('Alt+→ zoom in，zoom 状态存进 vscode.setState（用 nodeKey）', async ({ page }) => {
  await openOutline(page, [node('a', 'A', [node('a1', 'A1')])]);
  await focusText(page, 'a', 0);
  await page.keyboard.press('Alt+ArrowRight');

  expect(await textsInDom(page)).toEqual(['A', 'A1']);
  const state = await page.evaluate(() => (window as never as { __state: unknown }).__state);
  expect(state).toMatchObject({ zoomRootKey: expect.stringMatching(/^h:/) });
});

test('↑ / ↓ 在节点间移动光标，跳过被折叠的子树', async ({ page }) => {
  await openOutline(page, [
    node('a', 'alpha', [node('a1', 'hidden')]),
    node('b', 'beta'),
  ]);
  await page.locator('.node[data-id="a"] > .node-row > .toggle').click();

  await focusText(page, 'a', 3);
  await page.keyboard.press('ArrowDown');
  expect((await caretState(page)).id).toBe('b');

  await page.keyboard.press('ArrowUp');
  expect((await caretState(page)).id).toBe('a');
});

test('move / indent 之后折叠仍保留（折叠挂在内存 id 上，key 不含祖先路径）', async ({
  page,
}) => {
  await openOutline(page, [node('a', 'A', [node('a1', 'A1')]), node('b', 'B')]);
  await page.locator('.node[data-id="a"] > .node-row > .toggle').click();
  expect(await textsInDom(page)).toEqual(['A', 'B']);

  await focusText(page, 'a', 0);
  await page.keyboard.press('Alt+ArrowDown'); // moveDown
  expect(await textsInDom(page)).toEqual(['B', 'A']);
  await expect(page.locator('.node[data-id="a1"]')).toHaveCount(0); // 仍折叠

  await inject(page, { type: 'ack', seq: 1, version: 2 });
  await page.keyboard.press('Tab'); // indent 到 B 下面
  await expect(page.locator('.node[data-id="b"] > .children > .node[data-id="a"]')).toHaveCount(1);
  await expect(page.locator('.node[data-id="a1"]')).toHaveCount(0); // 依然折叠
});

test('外部 refresh 后折叠与 zoom 仍存活（id 被 treeMatch 复用）', async ({ page }) => {
  await openOutline(page, [node('a', 'A', [node('a1', 'A1')]), node('b', 'B', [node('b1', 'B1')])]);
  await page.locator('.node[data-id="b"] > .node-row > .toggle').click();
  expect(await textsInDom(page)).toEqual(['A', 'A1', 'B']);

  await inject(page, {
    type: 'refresh',
    version: 4,
    cause: 'external',
    snapshot: snapshot([
      node('a', 'A', [node('a1', 'A1')]),
      node('b', 'B', [node('b1', 'B1')]),
      node('c', 'C'),
    ]),
  });
  await expect(page.locator('.node[data-id="c"]')).toHaveCount(1);
  expect(await textsInDom(page)).toEqual(['A', 'A1', 'B', 'C']); // B 仍折叠
});

test('点击 bullet 聚焦节点后按 Enter → 在 zoom 根下新建子节点（而非同级兄弟）', async ({ page }) => {
  await openOutline(page, [node('a', 'Alpha'), node('b', 'Beta')]);
  await clearPosted(page);

  // 阅读中正文持有焦点，点 bullet 进入 zoom（焦点应保在正文）
  await focusText(page, 'a', 5);
  await page.locator('.node[data-id="a"] > .node-row > .bullet').click();
  await expect(page.locator('.breadcrumb .crumb')).toHaveText(['Home', 'Alpha']);

  await page.keyboard.press('Enter');
  const edit = await waitForEdit(page);
  const op = (edit.ops as Record<string, unknown>[])[0];
  expect(op).toMatchObject({ op: 'insertSubtree', parentId: 'a', index: 0 });
});

test('点击 bullet 进入 zoom（正文此前无焦点）后按 Enter → 仍在 zoom 根下新建子节点', async ({
  page,
}) => {
  await openOutline(page, [node('a', 'Alpha'), node('b', 'Beta')]);
  await clearPosted(page);

  await page.locator('.node[data-id="a"] > .node-row > .bullet').click();
  await expect(page.locator('.breadcrumb .crumb')).toHaveText(['Home', 'Alpha']);

  await page.keyboard.press('Enter');
  const edit = await waitForEdit(page);
  const op = (edit.ops as Record<string, unknown>[])[0];
  expect(op).toMatchObject({ op: 'insertSubtree', parentId: 'a', index: 0 });
});
