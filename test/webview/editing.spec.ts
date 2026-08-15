import { expect, test } from '@playwright/test';
import {
  HARNESS,
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

test('init 渲染层级与文本', async ({ page }) => {
  await openOutline(page, [node('a', 'Alpha', [node('a1', 'Alpha one')]), node('b', 'Beta')]);

  expect(await textsInDom(page)).toEqual(['Alpha', 'Alpha one', 'Beta']);
  await expect(page.locator('.node[data-id="a"] > .children > .node[data-id="a1"]')).toHaveCount(1);
  expect((await posted(page))[0]).toEqual({ type: 'ready' });
});

test('打字 → 防抖后发出 setText，光标不被打断', async ({ page }) => {
  await openOutline(page, [node('a', 'ab')]);
  await clearPosted(page);

  await focusText(page, 'a', 2);
  await page.keyboard.type('cd');

  const edit = await waitForEdit(page);
  expect(edit).toMatchObject({
    type: 'edit',
    baseVersion: 1,
    ops: [{ op: 'setText', id: 'a', text: 'abcd' }],
  });
  // 同一节点的连续输入合并成一条 op
  expect((edit.ops as unknown[]).length).toBe(1);
  expect(await caretState(page)).toEqual({ id: 'a', offset: 4 });
});

test('Enter 在行中拆分，光标落到新节点行首', async ({ page }) => {
  await openOutline(page, [node('a', 'hello')]);
  await clearPosted(page);

  await focusText(page, 'a', 2);
  await page.keyboard.press('Enter');

  const edit = await waitForEdit(page);
  const op = (edit.ops as Record<string, unknown>[])[0];
  expect(op).toMatchObject({ op: 'split', id: 'a', offset: 2 });
  expect(await textsInDom(page)).toEqual(['he', 'llo']);
  expect(await caretState(page)).toEqual({ id: op.newId as string, offset: 0 });
});

test('Enter 在有子节点的节点行尾 → 新建第一个子节点', async ({ page }) => {
  await openOutline(page, [node('a', 'parent', [node('a1', 'child')])]);
  await clearPosted(page);

  await focusText(page, 'a', 6);
  await page.keyboard.press('Enter');

  const edit = await waitForEdit(page);
  const op = (edit.ops as Record<string, unknown>[])[0];
  expect(op).toMatchObject({ op: 'insertSubtree', parentId: 'a', index: 0 });
  expect(await textsInDom(page)).toEqual(['parent', '', 'child']);
});

test('Tab / Shift+Tab 缩进，光标偏移保持', async ({ page }) => {
  await openOutline(page, [node('a', 'first'), node('b', 'second')]);
  await clearPosted(page);

  await focusText(page, 'b', 3);
  await page.keyboard.press('Tab');

  let edit = await waitForEdit(page);
  expect(edit.ops).toEqual([{ op: 'indent', id: 'b' }]);
  await expect(page.locator('.node[data-id="a"] > .children > .node[data-id="b"]')).toHaveCount(1);
  expect(await caretState(page)).toEqual({ id: 'b', offset: 3 });

  await inject(page, { type: 'ack', seq: 1, version: 2 });
  await clearPosted(page);
  await page.keyboard.press('Shift+Tab');
  edit = await waitForEdit(page);
  expect(edit).toMatchObject({ baseVersion: 2, ops: [{ op: 'outdent', id: 'b' }] });
  await expect(page.locator('#outline-root .list-block > .node[data-id="b"]')).toHaveCount(1);
});

test('行首 Backspace 与上一个节点合并，光标落在 junction', async ({ page }) => {
  await openOutline(page, [node('a', 'foo'), node('b', 'bar')]);
  await clearPosted(page);

  await focusText(page, 'b', 0);
  await page.keyboard.press('Backspace');

  const edit = await waitForEdit(page);
  expect(edit.ops).toEqual([{ op: 'mergeWithPrevious', id: 'b' }]);
  expect(await textsInDom(page)).toEqual(['foobar']);
  expect(await caretState(page)).toEqual({ id: 'a', offset: 3 });
});

test('有子节点时行首 Backspace 不合并（no-op 不产生消息）', async ({ page }) => {
  await openOutline(page, [node('a', 'foo'), node('b', 'bar', [node('b1', 'child')])]);
  await clearPosted(page);

  await focusText(page, 'b', 0);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(500);

  expect(await posted(page)).toEqual([]);
  expect(await textsInDom(page)).toEqual(['foo', 'bar', 'child']);
});

test('空父节点 Backspace 删除父壳并按原序提升子节点（一个 undo 步）', async ({ page }) => {
  await openOutline(page, [node('p', '', [node('c1', '一'), node('c2', '二')]), node('after', '后')]);
  await focusText(page, 'p', 0);
  await clearPosted(page);

  await page.keyboard.press('Backspace');
  const edit = await waitForEdit(page);
  expect(edit.ops).toEqual([
    { op: 'outdent', id: 'c2' },
    { op: 'outdent', id: 'c1' },
    { op: 'delete', id: 'p' },
  ]);
  expect(await textsInDom(page)).toEqual(['一', '二', '后']);
  await expect(page.locator('.list-block > .node[data-id="c1"]')).toHaveCount(1);
  await expect(page.locator('.list-block > .node[data-id="c2"]')).toHaveCount(1);
  expect(await caretState(page)).toEqual({ id: 'c1', offset: 0 });
});

test('带备注或代码块的空父节点 Backspace 不误删', async ({ page }) => {
  await openOutline(page, [
    { ...node('note', '', [node('note-child', '备注子项')]), note: '说明' },
    { ...node('code', '', [node('code-child', '代码子项')]), note: '```ts\nconst x = 1;\n```' },
  ]);
  await clearPosted(page);

  await focusText(page, 'note', 0);
  await page.keyboard.press('Backspace');
  await focusText(page, 'code', 0);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);

  expect(await posted(page)).toEqual([]);
  expect(await textsInDom(page)).toEqual(['', '备注子项', '', '代码子项']);
  await expect(page.locator('.node[data-id="code"] .node-code')).toHaveCount(1);
});

test('Cmd/Ctrl+Shift+Backspace 删除叶节点；带后代时先确认且可取消', async ({ page }) => {
  await openOutline(page, [node('p', '父', [node('c', '子')]), node('leaf', '叶')]);
  await focusText(page, 'leaf', 1);
  await clearPosted(page);
  await page.keyboard.press('Control+Shift+Backspace');
  expect((await waitForEdit(page)).ops).toEqual([{ op: 'delete', id: 'leaf' }]);

  await inject(page, { type: 'ack', seq: 1, version: 2 });
  await focusText(page, 'p', 1);
  await clearPosted(page);
  await page.keyboard.press('Control+Shift+Backspace');
  await expect(page.locator('.confirm-dialog')).toBeVisible();
  await expect(page.locator('.confirm-message')).toContainText('1 descendant');
  await page.locator('.confirm-cancel').click();
  expect(await posted(page)).toEqual([]);
  await expect(page.locator('.node[data-id="p"]')).toHaveCount(1);

  await page.keyboard.press('Control+Shift+Backspace');
  await page.locator('.confirm-delete').click();
  expect((await waitForEdit(page)).ops).toEqual([{ op: 'delete', id: 'p' }]);
  await expect(page.locator('.node[data-id="p"]')).toHaveCount(0);
});

test('Cmd/Ctrl+Shift+Backspace 可删除文档中的唯一节点', async ({ page }) => {
  await openOutline(page, [node('only', '唯一节点')]);
  await clearPosted(page);
  await focusText(page, 'only', 2);

  await page.keyboard.press('Control+Shift+Backspace');

  expect((await waitForEdit(page)).ops).toEqual([{ op: 'delete', id: 'only' }]);
  await expect(page.locator('.node')).toHaveCount(0);
  await expect(page.locator('#outline-placeholder')).toBeVisible();
});

test('首节点为空时 Backspace 删除该节点，光标落到下一个节点', async ({ page }) => {
  await openOutline(page, [node('e0', ''), node('n1', '1'), node('n2', '2')]);
  await clearPosted(page);

  await focusText(page, 'e0', 0);
  await page.keyboard.press('Backspace');

  const edit = await waitForEdit(page);
  expect(edit.ops).toEqual([{ op: 'delete', id: 'e0' }]);
  expect(await textsInDom(page)).toEqual(['1', '2']);
  expect(await caretState(page)).toEqual({ id: 'n1', offset: 0 });
});

test('尾节点为空时 Backspace 合并进前一个节点（不残留空行）', async ({ page }) => {
  await openOutline(page, [node('n1', '1'), node('n2', '2'), node('e1', '')]);
  await clearPosted(page);

  await focusText(page, 'e1', 0);
  await page.keyboard.press('Backspace');

  const edit = await waitForEdit(page);
  expect(edit.ops).toEqual([{ op: 'mergeWithPrevious', id: 'e1' }]);
  expect(await textsInDom(page)).toEqual(['1', '2']);
  expect(await caretState(page)).toEqual({ id: 'n2', offset: 1 });
});

test('首节点非空时 Backspace 不删除（不丢正文，保持 no-op）', async ({ page }) => {
  await openOutline(page, [node('a', 'foo'), node('b', 'bar')]);
  await clearPosted(page);

  await focusText(page, 'a', 0);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(500);

  expect(await posted(page)).toEqual([]);
  expect(await textsInDom(page)).toEqual(['foo', 'bar']);
});

test('文档仅剩一个空节点时 Backspace 不删除（不留空文档）', async ({ page }) => {
  await openOutline(page, [node('only', '')]);
  await clearPosted(page);

  await focusText(page, 'only', 0);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(500);

  expect(await posted(page)).toEqual([]);
  expect(await textsInDom(page)).toEqual(['']);
});

test('结构 op 之前先 flush 待发的 setText', async ({ page }) => {
  await openOutline(page, [node('a', 'ab')]);
  await clearPosted(page);

  await focusText(page, 'a', 2);
  await page.keyboard.type('c'); // 300ms 防抖尚未到期
  await page.keyboard.press('Enter');

  await page.waitForTimeout(600);
  // 结构 op 先把待发的 setText 顶出去；它自己要等 ack（in-flight 期间不叠发，
  // 否则 baseVersion 必然失配）
  let edits = (await posted(page)).filter((m) => m.type === 'edit');
  expect(edits).toHaveLength(1);
  expect(edits[0].ops).toEqual([{ op: 'setText', id: 'a', text: 'abc' }]);
  expect(await textsInDom(page)).toEqual(['abc', '']); // 本地已乐观拆分（光标在行尾）

  await inject(page, { type: 'ack', seq: 1, version: 2 });
  await page.waitForTimeout(200);
  edits = (await posted(page)).filter((m) => m.type === 'edit');
  expect(edits).toHaveLength(2);
  expect((edits[1].ops as Record<string, unknown>[])[0]).toMatchObject({ op: 'split', id: 'a' });
  expect(edits[1]).toMatchObject({ baseVersion: 2 });
});

test('未 ack 前不发第二条 edit，ack 后补发', async ({ page }) => {
  await openOutline(page, [node('a', 'x'), node('b', 'y')]);
  await clearPosted(page);

  await focusText(page, 'b', 1);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(100);
  await focusText(page, 'b', 1);
  await page.keyboard.press('Shift+Tab');
  await page.waitForTimeout(300);

  // 第一条 edit 还没 ack，第二条必须留在队列里（否则 baseVersion 必然失配）
  expect((await posted(page)).filter((m) => m.type === 'edit')).toHaveLength(1);

  await inject(page, { type: 'ack', seq: 1, version: 2 });
  await page.waitForTimeout(200);
  const edits = (await posted(page)).filter((m) => m.type === 'edit');
  expect(edits).toHaveLength(2);
  expect(edits[1]).toMatchObject({ baseVersion: 2, seq: 2, ops: [{ op: 'outdent', id: 'b' }] });
});

test('refresh 应用快照并按 id 保住光标', async ({ page }) => {
  await openOutline(page, [node('a', 'alpha'), node('b', 'beta')]);
  await focusText(page, 'b', 2);
  await clearPosted(page);

  await inject(page, {
    type: 'refresh',
    version: 5,
    cause: 'external',
    snapshot: snapshot([node('a', 'alpha'), node('b', 'beta'), node('c', 'gamma')]),
  });
  await expect(page.locator('.node')).toHaveCount(3);

  expect(await textsInDom(page)).toEqual(['alpha', 'beta', 'gamma']);
  expect(await caretState(page)).toEqual({ id: 'b', offset: 2 });

  // 之后的 edit 用 refresh 带来的新 version
  await focusText(page, 'a', 5);
  await page.keyboard.type('!');
  expect(await waitForEdit(page)).toMatchObject({ baseVersion: 5 });
});

test('conflict refresh 把未提交的文本重新提交', async ({ page }) => {
  await openOutline(page, [node('a', 'alpha')]);
  await focusText(page, 'a', 5);
  await page.keyboard.type('X'); // 还在防抖窗口里
  await clearPosted(page);

  await inject(page, {
    type: 'refresh',
    version: 9,
    cause: 'conflict',
    snapshot: snapshot([node('a', 'alpha'), node('z', '外部插入')]),
  });
  await expect(page.locator('.node')).toHaveCount(2);

  const edit = await waitForEdit(page);
  expect(edit).toMatchObject({ baseVersion: 9, ops: [{ op: 'setText', id: 'a', text: 'alphaX' }] });
  expect(await textsInDom(page)).toEqual(['alphaX', '外部插入']);
});

test('undo 三道闸：Ctrl/Cmd+Z 转发 host，浏览器原生 undo 被封死', async ({ page }) => {
  await openOutline(page, [node('a', 'abc')]);
  await clearPosted(page);

  await focusText(page, 'a', 3);
  await page.keyboard.type('d');
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(200);

  const messages = await posted(page);
  // 先 flush 未发的 setText，再 requestUndo
  expect(messages.filter((m) => m.type === 'edit')).toHaveLength(1);
  expect(messages.at(-1)).toEqual({ type: 'requestUndo' });
  // 浏览器没有自己回退文本（回退只能由 host 的 refresh 带回来）
  expect(await textsInDom(page)).toEqual(['abcd']);

  await page.keyboard.press('ControlOrMeta+Shift+z');
  await page.waitForTimeout(100);
  expect((await posted(page)).at(-1)).toEqual({ type: 'requestRedo' });
});

test('beforeinput 的 historyUndo 被拦截', async ({ page }) => {
  await openOutline(page, [node('a', 'abc')]);
  await focusText(page, 'a', 3);

  const defaultPrevented = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.node[data-id="a"] [data-field="text"]')!;
    const event = new InputEvent('beforeinput', {
      inputType: 'historyUndo',
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(defaultPrevented).toBe(true);
});

test('空文档：点击占位创建第一个节点', async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => (window as never as { __posted: unknown[] }).__posted.length > 0);
  await inject(page, {
    type: 'init',
    snapshot: { indentUnit: { kind: 'space', width: 2 }, blocks: [] },
    version: 1,
    foldedKeys: [],
    config: {
      defaultIndent: { kind: 'space', width: 2 },
      defaultFold: 'none',
      rememberFolding: true,
    },
  });

  await page.locator('#outline-placeholder').click();
  const edit = await waitForEdit(page);
  expect((edit.ops as Record<string, unknown>[])[0]).toMatchObject({
    op: 'insertSubtree',
    parentId: null,
    index: 0,
  });
  await expect(page.locator('.node')).toHaveCount(1);
});
