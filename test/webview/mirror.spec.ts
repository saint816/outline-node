// M6 镜像引用：同文件双向同步、断链降级、循环引用占位、复制镜像链接。
import { expect, test } from '@playwright/test';
import { clearPosted, focusText, node, openOutline, posted, waitForEdit } from './support.js';

const source = (id: string, text: string, blockId: string, children = []) => ({
  id,
  text,
  blockId,
  children,
});
const mirrorRow = (id: string, blockId: string) => ({
  id,
  text: `![[#^${blockId}]]`,
  mirror: blockId,
});

test('镜像行展开成原节点的第二个视图（复合 id 不与原视图冲突）', async ({ page }) => {
  await openOutline(page, [
    source('s', '写周报', 'k1', [node('s1', '收集数据')] as never),
    { id: 'w', text: '本周', children: [mirrorRow('m', 'k1')] },
  ]);

  await expect(page.locator('.node[data-id="s"]')).toHaveCount(1);
  await expect(page.locator('.node[data-id="m/s"]')).toHaveCount(1);
  await expect(page.locator('.node[data-id="m/s"] > .node-row > .text')).toHaveText('写周报');
  await expect(page.locator('.node[data-id="m/s1"] > .node-row > .text')).toHaveText('收集数据');
  await expect(page.locator('.node[data-id="m/s"]')).toHaveClass(/mirror-view/);
});

test('镜像视图里编辑 → 发出的 op 用原始 id，两个视图立即一致', async ({ page }) => {
  await openOutline(page, [
    source('s', '原文', 'k1'),
    { id: 'w', text: '本周', children: [mirrorRow('m', 'k1')] },
  ]);
  await clearPosted(page);

  await focusText(page, 'm/s', 2);
  await page.keyboard.type('改');

  const edit = await waitForEdit(page);
  expect(edit.ops).toEqual([{ op: 'setText', id: 's', text: '原文改' }]);
  await expect(page.locator('.node[data-id="s"] > .node-row > .text')).toHaveText('原文改');
  await expect(page.locator('.node[data-id="m/s"] > .node-row > .text')).toHaveText('原文改');
});

test('原视图编辑 → 镜像视图同步', async ({ page }) => {
  await openOutline(page, [
    source('s', '原文', 'k1'),
    { id: 'w', text: '本周', children: [mirrorRow('m', 'k1')] },
  ]);
  await focusText(page, 's', 2);
  await page.keyboard.type('X');

  await expect(page.locator('.node[data-id="m/s"] > .node-row > .text')).toHaveText('原文X');
});

test('镜像视图里的结构 op 也落到原子树', async ({ page }) => {
  await openOutline(page, [
    source('s', '父', 'k1', [node('s1', '子一'), node('s2', '子二')] as never),
    { id: 'w', text: '本周', children: [mirrorRow('m', 'k1')] },
  ]);
  await clearPosted(page);

  await focusText(page, 'm/s2', 0);
  await page.keyboard.press('Tab');

  const edit = await waitForEdit(page);
  expect(edit.ops).toEqual([{ op: 'indent', id: 's2' }]);
  await expect(page.locator('.node[data-id="s1"] > .children > .node[data-id="s2"]')).toHaveCount(1);
  // 复合 id 用「镜像行 id + 原 id」的常量前缀（见 docs/06）
  await expect(page.locator('.node[data-id="m/s1"] > .children > .node[data-id="m/s2"]')).toHaveCount(1);
});

test('断链：只读渲染 + 提示，原文不丢', async ({ page }) => {
  await openOutline(page, [node('a', '别的'), mirrorRow('m', 'missing')]);

  const row = page.locator('.node[data-id="m"]');
  await expect(row).toHaveClass(/mirror-broken/);
  await expect(row.locator('.mirror-hint')).toHaveText('Broken reference');
  await expect(row.locator('[data-field="text"]')).toHaveText('![[#^missing]]');
  await expect(row.locator('[data-field="text"]')).toHaveAttribute('contenteditable', 'false');
});

test('循环引用：占位符，不无限展开', async ({ page }) => {
  await openOutline(page, [source('s', '自引用', 'k1', [mirrorRow('m', 'k1')] as never)]);

  await expect(page.locator('.node[data-id="m"]')).toHaveClass(/mirror-cycle/);
  await expect(page.locator('.node[data-id="m"] .mirror-hint')).toHaveText('Circular reference');
  expect(await page.locator('.node').count()).toBe(2);
});

test('折叠在原视图与镜像视图之间共享（同一份数据）', async ({ page }) => {
  await openOutline(page, [
    source('s', '父', 'k1', [node('s1', '子')] as never),
    { id: 'w', text: '本周', children: [mirrorRow('m', 'k1')] },
  ]);
  await expect(page.locator('.node[data-id="m/s1"]')).toHaveCount(1);

  await page.locator('.node[data-id="s"] > .node-row > .toggle').click();
  await expect(page.locator('.node[data-id="s1"]')).toHaveCount(0);
  await expect(page.locator('.node[data-id="m/s1"]')).toHaveCount(0);
});

test('右键「复制为镜像链接」：无 blockId 时先 assignBlockId', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openOutline(page, [node('a', '要被镜像的节点')]);
  await clearPosted(page);

  await page.locator('.node[data-id="a"] > .node-row > .text').click({ button: 'right' });
  await expect(page.locator('.context-menu-item')).toHaveText('Copy as mirror link');
  await page.locator('.context-menu-item').click();

  const edit = await waitForEdit(page);
  const op = (edit.ops as Record<string, unknown>[])[0];
  expect(op).toMatchObject({ op: 'assignBlockId', id: 'a' });
  expect(op.blockId).toMatch(/^[0-9a-z]{6}$/);

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(`![[#^${op.blockId as string}]]`);
  await expect(page.locator('.node[data-id="a"] .block-id-badge')).toHaveText(`^${op.blockId as string}`);
});

test('已有 blockId 时不重复 assign，只写剪贴板', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openOutline(page, [source('a', '已有 id', 'k3f9a2')]);
  await clearPosted(page);

  await page.locator('.node[data-id="a"] > .node-row > .text').click({ button: 'right' });
  await page.locator('.context-menu-item').click();
  await page.waitForTimeout(400);

  expect((await posted(page)).filter((m) => m.type === 'edit')).toEqual([]);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('![[#^k3f9a2]]');
});
