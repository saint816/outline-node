// 0.2.0 新增：内嵌侧栏（顶层导航 + 星标）、隐藏已完成、zoom 前进/后退、帮助浮层。
// 0.4.0 新增：侧栏树拖拽移动节点。
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  CONFIG,
  clearPosted,
  focusText,
  inject,
  node,
  openOutline,
  posted,
  snapshot,
  waitForEdit,
} from './support.js';

interface PostedWindow {
  __posted: { type: string; bookmarkKeys?: string[] }[];
}

/** 拖侧栏某一行到目标行下沿；depth 由横向位置换算（步长 13px，基准 4px，与 styles.css 一致）。 */
async function dragSidebar(
  page: Page,
  fromId: string,
  toId: string,
  opts: { depth?: number } = {},
): Promise<void> {
  const from = await page.locator(`.sidebar-item[data-id="${fromId}"]`).boundingBox();
  const to = await page.locator(`.sidebar-item[data-id="${toId}"]`).boundingBox();
  const body = await page.locator('.sidebar-body').boundingBox();
  if (!from || !to || !body) throw new Error('missing sidebar element');
  const targetX = body.x + 4 + (opts.depth ?? 0) * 13 + 4;

  // 从行左侧起手（避开右端的星标按钮）
  await page.mouse.move(from.x + 18, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 18, from.y + from.height / 2 + 10, { steps: 2 });
  await page.mouse.move(targetX, to.y + to.height - 2, { steps: 4 });
  await page.mouse.up();
}

test('侧栏列出顶层节点，点击即 zoom 进子树', async ({ page }) => {
  await openOutline(page, [node('a', 'Alpha', [node('a1', 'A1')]), node('b', 'Beta')]);

  const sidebar = page.locator('.sidebar');
  await expect(sidebar.locator('.sidebar-label')).toHaveText(['Home', 'Alpha', 'Beta']);

  await sidebar.getByRole('button', { name: 'Beta', exact: true }).click();
  await expect(page.locator('.breadcrumb .crumb')).toHaveText(['Home', 'Beta']);
});

test('侧栏拖拽：同层重排，发出单条 move op', async ({ page }) => {
  await openOutline(page, [node('a', 'Alpha'), node('b', 'Beta'), node('c', 'Gamma')]);
  await clearPosted(page);

  // 把 Gamma 拖到 Alpha 下沿、同层 → 落在 Alpha 之后
  await dragSidebar(page, 'c', 'a', { depth: 0 });

  const edit = await waitForEdit(page);
  expect(edit.ops).toEqual([{ op: 'move', id: 'c', parentId: null, index: 1 }]);
  // 侧栏顺序随之更新
  await expect(page.locator('.sidebar .sidebar-item.sidebar-draggable .sidebar-label')).toHaveText([
    'Alpha',
    'Gamma',
    'Beta',
  ]);
});

test('侧栏拖拽：拖到兄弟节点下沿 + 缩进 → 成为其子节点', async ({ page }) => {
  await openOutline(page, [node('a', 'Alpha'), node('b', 'Beta'), node('c', 'Gamma')]);
  await clearPosted(page);

  await dragSidebar(page, 'c', 'a', { depth: 1 });

  const edit = await waitForEdit(page);
  expect(edit.ops).toEqual([{ op: 'move', id: 'c', parentId: 'a', index: 0 }]);
  // 主编辑区结构落定
  await expect(page.locator('.node[data-id="a"] > .children > .node[data-id="c"]')).toHaveCount(1);
});

test('侧栏拖拽：Esc 取消，不产生 op；随后普通点击仍能导航', async ({ page }) => {
  await openOutline(page, [node('a', 'Alpha'), node('b', 'Beta')]);
  await clearPosted(page);

  const from = (await page.locator('.sidebar-item[data-id="b"]').boundingBox())!;
  await page.mouse.move(from.x + 18, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 18, from.y + from.height / 2 + 30, { steps: 3 });
  await page.keyboard.press('Escape');
  await page.mouse.up();

  await page.waitForTimeout(300);
  expect((await posted(page)).filter((m) => m.type === 'edit')).toEqual([]);

  // 取消拖拽后，普通点击不被 suppressClick 误吞
  await page.locator('.sidebar').getByRole('button', { name: 'Alpha', exact: true }).click();
  await expect(page.locator('.breadcrumb .crumb')).toHaveText(['Home', 'Alpha']);
});

test('侧栏大纲树可展开/折叠子节点（独立于主编辑区折叠）', async ({ page }) => {
  await openOutline(page, [
    node('a', 'Alpha', [node('a1', 'A1'), node('a2', 'A2')]),
    node('b', 'Beta'),
  ]);
  const sidebar = page.locator('.sidebar');
  // 默认收起：只显示顶层
  await expect(sidebar.locator('.sidebar-label')).toHaveText(['Home', 'Alpha', 'Beta']);

  const alphaToggle = sidebar
    .locator('.sidebar-item', { hasText: 'Alpha' })
    .locator('.sidebar-toggle')
    .first();
  // 展开 Alpha → 子节点出现，缩进
  await alphaToggle.click();
  await expect(sidebar.locator('.sidebar-label')).toHaveText(['Home', 'Alpha', 'A1', 'A2', 'Beta']);
  // 侧栏展开不影响主编辑区（a1 仍在正文里正常显示，未被折叠）
  await expect(page.locator('#outline-root .node[data-id="a1"]')).toBeVisible();

  // 再点收起
  await alphaToggle.click();
  await expect(sidebar.locator('.sidebar-label')).toHaveText(['Home', 'Alpha', 'Beta']);
});

test('星标：进入 Starred 区、节流上报 saveBookmarks，reopen 后按 nodeKey 恢复', async ({ page }) => {
  await openOutline(page, [node('a', 'Alpha'), node('b', 'Beta')]);

  await page.locator('.sidebar-item', { hasText: 'Alpha' }).locator('.sidebar-star').click();
  await expect(page.locator('.sidebar-section', { hasText: 'Starred' })).toBeVisible();

  await page.waitForFunction(
    () =>
      (window as never as PostedWindow).__posted.some(
        (m) => m.type === 'saveBookmarks' && (m.bookmarkKeys?.length ?? 0) === 1,
      ),
    undefined,
    { timeout: 3000 },
  );
  const key = ((await posted(page)).find((m) => m.type === 'saveBookmarks') as { bookmarkKeys: string[] })
    .bookmarkKeys[0];

  // reopen：换成不同的 id、同样的文本，init 带上刚才的书签 key → 星标必须存活
  await inject(page, {
    type: 'init',
    snapshot: snapshot([node('a2', 'Alpha'), node('b2', 'Beta')]),
    version: 2,
    foldedKeys: [],
    bookmarkKeys: [key],
    config: CONFIG,
  });
  await expect(page.locator('.sidebar-section', { hasText: 'Starred' })).toBeVisible();
});

test('Cmd/Ctrl+O 隐藏已完成节点（连整棵子树），再按恢复', async ({ page }) => {
  await openOutline(page, [node('a', 'Done', [node('a1', 'child')]), node('b', 'Todo')]);

  await focusText(page, 'a', 0);
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('.node[data-id="a"] > .node-row')).toHaveClass(/checked/);

  await focusText(page, 'b', 0);
  await page.keyboard.press('Control+o');
  await expect(page.locator('.node[data-id="a"]')).toBeHidden();
  await expect(page.locator('.node[data-id="a1"]')).toBeHidden();
  await expect(page.locator('.node[data-id="b"]')).toBeVisible();

  await page.keyboard.press('Control+o');
  await expect(page.locator('.node[data-id="a"]')).toBeVisible();
});

test('焦点在完成节点上按 Cmd/Ctrl+O：隐藏后焦点迁到可见节点，再按能恢复（BUG-002）', async ({
  page,
}) => {
  await openOutline(page, [node('a', 'Done'), node('b', 'Todo')]);

  // 让完成节点 a 自己持有焦点
  await focusText(page, 'a', 0);
  await page.keyboard.press('Control+Enter');
  await focusText(page, 'a', 0);

  // 第一次：隐藏 a。焦点不能留在被隐藏的 a（否则 root 级监听收不到下次按键）
  await page.keyboard.press('Control+o');
  await expect(page.locator('.node[data-id="a"]')).toBeHidden();
  const focusedNodeId = await page.evaluate(
    () => document.activeElement?.closest('.node')?.getAttribute('data-id') ?? null,
  );
  expect(focusedNodeId).toBe('b'); // 焦点已迁到可见节点，不在 body

  // 第二次：同一快捷键必须能恢复显示（陷阱已解）
  await page.keyboard.press('Control+o');
  await expect(page.locator('.node[data-id="a"]')).toBeVisible();
});

test('工具条 zoom 后退 / 前进', async ({ page }) => {
  await openOutline(page, [node('a', 'A', [node('a1', 'A1')]), node('b', 'B')]);

  await page.locator('.node[data-id="a"] > .node-row > .bullet').click();
  await expect(page.locator('.breadcrumb .crumb')).toHaveText(['Home', 'A']);

  await page.locator('.topbar-nav button').first().click(); // 后退
  await expect(page.locator('.breadcrumb')).toBeHidden();

  await page.locator('.topbar-nav button').nth(1).click(); // 前进
  await expect(page.locator('.breadcrumb .crumb')).toHaveText(['Home', 'A']);
});

test('? 打开快捷键帮助，Esc 关闭；在可编辑节点里输入 ? 不弹出', async ({ page }) => {
  await openOutline(page, [node('a', 'A')]);

  // 焦点在节点正文里：? 是正常输入，不弹帮助
  await focusText(page, 'a', 0);
  await page.keyboard.type('?');
  await expect(page.locator('.help-overlay')).toHaveCount(0);

  // 焦点移出可编辑元素：? 打开帮助
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true })));
  await expect(page.locator('.help-overlay')).toBeVisible();
  await expect(page.locator('.help-list dt')).not.toHaveCount(0);

  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await expect(page.locator('.help-overlay')).toHaveCount(0);
});

test('侧栏可收起 / 展开', async ({ page }) => {
  await openOutline(page, [node('a', 'A')]);

  await expect(page.locator('.sidebar')).not.toHaveClass(/collapsed/);
  await page.locator('.sidebar-collapse').click();
  await expect(page.locator('.sidebar')).toHaveClass(/collapsed/);
  await page.locator('.sidebar-collapse').click();
  await expect(page.locator('.sidebar')).not.toHaveClass(/collapsed/);
});

test('侧栏：编辑顶层节点文本，label 实时跟上（打字热路径不整树重渲染）', async ({ page }) => {
  await openOutline(page, [node('a', 'Alpha'), node('b', 'Beta')]);
  const sidebar = page.locator('.sidebar');
  await expect(sidebar.locator('.sidebar-label')).toHaveText(['Home', 'Alpha', 'Beta']);

  await focusText(page, 'a', 5); // 光标到 'Alpha' 末尾
  await page.keyboard.type('X');

  // 打字不发结构 op、不 emit，但侧栏 label 立即变 AlphaX（syncText 热更新）
  await expect(sidebar.locator('.sidebar-label')).toHaveText(['Home', 'AlphaX', 'Beta']);
});

test('侧栏：编辑展开子树里的节点，label 也实时跟上（不止顶层）', async ({ page }) => {
  await openOutline(page, [node('a', 'Alpha', [node('a1', 'Child')])]);
  const sidebar = page.locator('.sidebar');

  // 侧栏树默认折叠，先展开 a
  await sidebar.locator('.sidebar-item[data-id="a"] .sidebar-toggle').click();
  await expect(sidebar.locator('.sidebar-label')).toHaveText(['Home', 'Alpha', 'Child']);

  await focusText(page, 'a1', 5); // 'Child' 末尾
  await page.keyboard.type('!');

  await expect(sidebar.locator('.sidebar-label')).toHaveText(['Home', 'Alpha', 'Child!']);
});

test('侧栏：节点文本清空后 label 回落到 (empty node) 占位', async ({ page }) => {
  await openOutline(page, [node('a', 'Alpha')]);
  const sidebar = page.locator('.sidebar');
  await expect(sidebar.locator('.sidebar-label')).toHaveText(['Home', 'Alpha']);

  await focusText(page, 'a', 0);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');

  await expect(sidebar.locator('.sidebar-label')).toHaveText(['Home', '(empty node)']);
});
