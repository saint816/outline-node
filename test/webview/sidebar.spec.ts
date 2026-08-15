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

/** 拖侧栏某一行到目标行下沿；depth 由横向位置换算（步长 13px，基准 17px，与 styles.css 一致）。 */
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
  const targetX = body.x + 17 + (opts.depth ?? 0) * 13 + 4;

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

test('侧栏进入节点后焦点回到正文，可立即 Shift+↓ 多选子节点', async ({ page }) => {
  await openOutline(page, [node('a', 'Alpha', [node('a1', 'A1'), node('a2', 'A2')])]);
  await page.locator('.sidebar-item[data-id="a"] .sidebar-label').click();
  await expect(page.locator('.node[data-id="a"] > .node-row > [data-field="text"]')).toBeFocused();
  await page.keyboard.press('Shift+ArrowDown');
  await expect(page.locator('.node[data-id="a"]')).toHaveClass(/selected/);
});

test('侧栏 zoom 进首个已折叠节点后可 Shift+↓ 多选子节点，退出仍保留折叠态', async ({ page }) => {
  await openOutline(page, [node('a', 'Alpha', [node('a1', 'A1'), node('a2', 'A2')])]);

  // 全文档视图中先折叠 Alpha；这是用户截图中「右侧只有标题」的触发条件。
  await page.locator('.node[data-id="a"] > .node-row > .toggle').click();
  await expect(page.locator('#outline-root .node[data-id="a1"]')).toHaveCount(0);

  await page.locator('.sidebar-item[data-id="a"] .sidebar-label').click();
  await expect(page.locator('.breadcrumb .crumb')).toHaveText(['Home', 'Alpha']);
  await expect(page.locator('#outline-root .node[data-id="a1"]')).toBeVisible();
  await expect(page.locator('#outline-root .node[data-id="a2"]')).toBeVisible();

  // renderer 强制展开 zoom 根后，selection 的可见顺序也必须包含这些子节点。
  // 旧实现仍按 folded 截断 visibleRows，导致 Home 下第一个默认折叠节点无法扩选。
  await expect(page.locator('.node[data-id="a"] > .node-row > [data-field="text"]')).toBeFocused();
  await page.keyboard.press('Shift+ArrowDown');
  await expect(page.locator('.node[data-id="a"]')).toHaveClass(/selected/);
  await page.keyboard.press('Escape');

  // zoom 只覆盖渲染语义，不修改折叠 UI 状态；回 Home 后仍应是折叠的。
  await page.locator('.sidebar-home .sidebar-label').click();
  await expect(page.locator('#outline-root .node[data-id="a1"]')).toHaveCount(0);
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

test('同一节点在 Starred 与 Home 树中只高亮实际点击的副本', async ({ page }) => {
  await openOutline(page, [node('a', 'Alpha'), node('b', 'Beta')]);
  await page.locator('.sidebar-item[data-id="a"] .sidebar-star').click();
  await expect(page.locator('.sidebar-item[data-nav-section="starred"]')).toBeVisible();

  const starred = page.locator('.sidebar-item[data-nav-section="starred"]');
  const outline = page.locator('.sidebar-item[data-nav-section="outline"][data-id="a"]');

  await outline.locator('.sidebar-label').click();
  await expect(outline).toHaveClass(/active/);
  await expect(starred).not.toHaveClass(/active/);

  // zoom id 没变化，只切换导航入口；仍必须把 active 从 Home 移到 Starred。
  await starred.locator('.sidebar-label').click();
  await expect(starred).toHaveClass(/active/);
  await expect(outline).not.toHaveClass(/active/);
});

// 分区标题即折叠开关；Home 就是大纲区的标题行（不再单列一行），三角折叠、文字回全文档。
test('侧栏分区可折叠，且状态存进 ViewState', async ({ page }) => {
  await openOutline(page, [node('a', 'Alpha'), node('b', 'Beta')]);
  await page.locator('.sidebar-item', { hasText: 'Alpha' }).locator('.sidebar-star').click();
  // Starred 里的 Alpha + Home（大纲区标题）+ 大纲的 Alpha/Beta
  await expect(page.locator('.sidebar-label')).toHaveText(['Alpha', 'Home', 'Alpha', 'Beta']);

  await page.locator('.sidebar-section[data-section="starred"]').click();
  await expect(page.locator('.sidebar-label')).toHaveText(['Home', 'Alpha', 'Beta']);
  await expect(page.locator('.sidebar-section[data-section="starred"]')).toHaveAttribute(
    'aria-expanded',
    'false',
  );

  // 折叠大纲区：Home 这行自己留着（它就是标题），树收起来
  await page.locator('.sidebar-toggle[data-section="outline"]').click();
  await expect(page.locator('.sidebar-label')).toHaveText(['Home']);

  const saved = await page.evaluate(
    () => (window as never as { __state?: { sidebarSections?: string[] } }).__state?.sidebarSections,
  );
  expect(saved?.slice().sort()).toEqual(['outline', 'starred']);

  await page.locator('.sidebar-section[data-section="starred"]').click();
  await expect(page.locator('.sidebar-label')).toHaveText(['Alpha', 'Home']);
});

test('Home 只出现一次，且点它回到全文档', async ({ page }) => {
  await openOutline(page, [node('a', 'Alpha', [node('a1', 'A1')])]);
  await expect(page.locator('.sidebar-label', { hasText: /^Home$/ })).toHaveCount(1);

  await page.locator('.sidebar-item[data-id="a"] .sidebar-label').click();
  await expect(page.locator('.breadcrumb .crumb')).toHaveText(['Home', 'Alpha']);

  await page.locator('.sidebar-home .sidebar-label').click();
  await expect(page.locator('.breadcrumb .crumb')).toHaveCount(0);
  // Home 是常驻入口，不是「当前位置」：任何时候都不打 .active（常年高亮像误选中）
  await expect(page.locator('.sidebar-home')).not.toHaveClass(/active/);
});

// 侧栏每次 render 整栏重建：行上若有 hover 过渡，展开一个节点时鼠标下那行会「闪一下」
// （过渡从头重播）。这里锁死「侧栏行内元素不带过渡」，避免以后又加回来。
test('侧栏行不带 hover 过渡（重建时会重播成闪烁）', async ({ page }) => {
  await openOutline(page, [node('a', 'Alpha', [node('a1', 'A1')])]);
  await page.locator('.sidebar-item[data-id="a"] .sidebar-star').click();
  // 星标后侧栏重渲染是异步的，等 Starred 区出现再读样式（evaluate 不会自动重试）
  await expect(page.locator('.sidebar-section')).toBeVisible();

  const durations = await page.evaluate(() =>
    ['.sidebar-item', '.sidebar-section', '.sidebar-toggle', '.sidebar-star', '.sidebar-label'].map(
      (sel) => getComputedStyle(document.querySelector(sel)!).transitionDuration,
    ),
  );
  expect(durations).toEqual(['0s', '0s', '0s', '0s', '0s']);
});

// 分区标题是 font-weight:600 的 button、树行三角是默认字体的 button：不显式对齐字体三件套，
// 两个 ▸ 会渲染成明显不同的大小（实机反馈）。
test('分区三角与节点三角字体一致', async ({ page }) => {
  await openOutline(page, [node('a', 'Alpha', [node('a1', 'A1')])]);
  await page.locator('.sidebar-item[data-id="a"] .sidebar-star').click();

  const font = (sel: string): Promise<string> =>
    page.locator(sel).first().evaluate((el) => {
      const css = getComputedStyle(el);
      return `${css.fontSize}|${css.fontWeight}|${css.fontFamily}`;
    });

  expect(await font('.sidebar-section-caret')).toBe(await font('.sidebar-toggle'));

  // 两种三角 hover 都要提亮（分区三角曾经只有节点三角有 hover）。
  // 提亮带 80ms 过渡，用 poll 等它走完，别读到中间值。
  const opacity = (sel: string) => (): Promise<string> =>
    page.locator(sel).first().evaluate((el) => getComputedStyle(el).opacity);
  await page.locator('.sidebar-section').first().hover();
  await expect.poll(opacity('.sidebar-section-caret')).toBe('1');
  await page.locator('.sidebar-item[data-id="a"]').hover();
  await expect.poll(opacity('.sidebar-item[data-id="a"] .sidebar-toggle')).toBe('1');
});

test('Ctrl+O 隐藏已完成节点（连整棵子树），再按恢复', async ({ page }) => {
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

test('焦点在完成节点上按 Ctrl+O：隐藏后焦点迁到可见节点，再按能恢复（BUG-002）', async ({
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

// 键位随平台变（见 webview/platform.ts）：mac 用 Ctrl+O（VS Code 未占），
// Windows/Linux 上 Ctrl+O 是「打开文件」，退回 Ctrl+Alt+O。
test('非 mac 平台：隐藏已完成走 Ctrl+Alt+O，裸 Ctrl+O 不触发', async ({ page }) => {
  await openOutline(page, [node('a', 'Done'), node('b', 'Todo')]);
  await page.evaluate(() => {
    document.documentElement.dataset.platform = 'other';
  });

  await focusText(page, 'a', 0);
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('.node[data-id="a"] > .node-row')).toHaveClass(/checked/);

  await focusText(page, 'b', 0);
  await page.keyboard.press('Control+o'); // 该平台上这是「打开文件」，插件不该抢
  await expect(page.locator('.node[data-id="a"]')).toBeVisible();

  await page.keyboard.press('Control+Alt+o');
  await expect(page.locator('.node[data-id="a"]')).toBeHidden();
});
