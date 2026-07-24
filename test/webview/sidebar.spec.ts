// 0.2.0 新增：内嵌侧栏（顶层导航 + 星标）、隐藏已完成、zoom 前进/后退、帮助浮层。
import { expect, test } from '@playwright/test';
import { CONFIG, focusText, inject, node, openOutline, posted, snapshot } from './support.js';

interface PostedWindow {
  __posted: { type: string; bookmarkKeys?: string[] }[];
}

test('侧栏列出顶层节点，点击即 zoom 进子树', async ({ page }) => {
  await openOutline(page, [node('a', 'Alpha', [node('a1', 'A1')]), node('b', 'Beta')]);

  const sidebar = page.locator('.sidebar');
  await expect(sidebar.locator('.sidebar-label')).toHaveText(['Home', 'Alpha', 'Beta']);

  await sidebar.getByRole('button', { name: 'Beta', exact: true }).click();
  await expect(page.locator('.breadcrumb .crumb')).toHaveText(['Home', 'Beta']);
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
