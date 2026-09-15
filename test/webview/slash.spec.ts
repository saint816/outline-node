// 斜杠插入菜单（/ → Code）。To-do 与 Numbered 入口已移除，已有任务节点能力仍由 core 保留。
import { expect, test } from '@playwright/test';
import { clearPosted, focusText, inject, node, openOutline } from './support.js';

interface EditWindow {
  __posted: { type: string; ops?: { op: string; checked?: unknown; text?: string }[] }[];
}

/** 等待某个 op 出现在已发出的 edit 里（op 名 + 可选 checked 值）。 */
async function waitForOp(
  page: import('@playwright/test').Page,
  opName: string,
  checked?: boolean,
): Promise<void> {
  await page.waitForFunction(
    ({ opName, checked }) =>
      (window as never as EditWindow).__posted.some(
        (m) =>
          m.type === 'edit' &&
          (m.ops ?? []).some(
            (o) => o.op === opName && (checked === undefined || o.checked === checked),
          ),
      ),
    { opName, checked },
    { timeout: 3000 },
  );
}

test('空标题节点的 / 菜单提供 Divider 和 Code', async ({ page }) => {
  await openOutline(page, [node('a', '')]);
  await focusText(page, 'a', 0);
  await page.keyboard.type('/');

  const menu = page.locator('.slash-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.slash-item')).toHaveText([/Divider/, /Code block/]);
});

test('/code 可先创建代码块；空标题时聚焦必填标题行', async ({ page }) => {
  await openOutline(page, [node('a', ''), node('b', 'after')]);
  await focusText(page, 'a', 0);
  await page.keyboard.type('/code');
  await expect(page.locator('.slash-menu .slash-item')).toHaveText([/Code block/]);
  await page.keyboard.press('Enter');

  const title = page.locator('.node[data-id="a"] > .node-row > [data-field="text"]');
  await expect(page.locator('.node[data-id="a"] > .node-code textarea.code-input')).toHaveCount(1);
  await expect(title).toBeFocused();
  await expect(title).toHaveAttribute('data-placeholder', /Enter a node title/);
  await expect(page.locator('.node[data-id="a"] > .node-row')).toHaveClass(/code-title-missing/);
});

test('有标题的 /code 创建后标题始终保留', async ({ page }) => {
  await openOutline(page, [node('a', '解析 YAML '), node('b', 'after')]);
  await focusText(page, 'a', 8);
  await page.keyboard.type('/code');
  await expect(page.locator('.slash-menu .slash-item')).toHaveText([/Code block/]);
  await page.keyboard.press('Enter');

  const area = page.locator('.node[data-id="a"] > .node-code textarea.code-input');
  await expect(area).toHaveCount(1);
  await expect(area).toBeFocused();
  await expect(page.locator('.node[data-id="a"] > .node-row > [data-field="text"]')).toHaveText(
    '解析 YAML',
  );
  await expect(page.locator('.node[data-id="a"] > .node-row > .bullet')).toBeVisible();
  await expect(page.locator('.node[data-id="b"]')).toHaveCount(1);
  await expect(page.locator('#outline-root > .list-block > .raw-block.code-block')).toHaveCount(0);
});

test('/todo 不再提供类型入口，Enter 按普通节点拆分处理', async ({ page }) => {
  await openOutline(page, [node('a', '')]);
  await focusText(page, 'a', 0);
  await clearPosted(page);
  await page.keyboard.type('/todo');
  await expect(page.locator('.slash-menu .slash-empty')).toBeVisible();
  await page.keyboard.press('Enter');
  const edits = (await page.evaluate(() => (window as never as EditWindow).__posted)).filter(
    (message) => message.type === 'edit',
  );
  expect(edits.some((message) => (message.ops ?? []).some((op) => op.op === 'setChecked'))).toBe(false);
  await expect(page.locator('.node[data-id="a"] > .node-row > [data-field="text"]')).toHaveText('/todo');
});

test('/num 不再提供 Numbered 入口，Enter 按普通节点拆分处理', async ({ page }) => {
  await openOutline(page, [node('a', '')]);
  await focusText(page, 'a', 0);
  await clearPosted(page);
  await page.keyboard.type('/num');
  await expect(page.locator('.slash-menu .slash-empty')).toBeVisible();
  await page.keyboard.press('Enter');
  const edits = (await page.evaluate(() => (window as never as EditWindow).__posted)).filter(
    (message) => message.type === 'edit',
  );
  expect(
    edits.some((message) => (message.ops ?? []).some((op) => op.op === 'toggleOrdered')),
  ).toBe(false);
  await expect(page.locator('.node[data-id="a"] > .node-row > [data-field="text"]')).toHaveText('/num');
});

test('嵌套节点上标题 + /code：代码块挂到标题行下方', async ({ page }) => {
  await openOutline(page, [node('a', 'root', [node('a1', '示例 ')])]);
  await focusText(page, 'a1', 3);
  await clearPosted(page);
  await page.keyboard.type('/code');
  await expect(page.locator('.slash-menu .slash-item')).toHaveText([/Code block/]);
  await page.keyboard.press('Enter');

  // 节点保留，代码块挂在它下面并获得焦点
  await expect(page.locator('.node[data-id="a1"]')).toHaveCount(1);
  const area = page.locator('.node[data-id="a1"] > .node-code textarea.code-input');
  await expect(area).toHaveCount(1);
  await expect(area).toBeFocused();
  // 顶层文档级代码块不该出现
  await expect(page.locator('#outline-root > .list-block > .raw-block.code-block')).toHaveCount(0);

  await inject(page, { type: 'ack', seq: 1, version: 2 });
  await waitForOp(page, 'setNote');
});

test('已有备注的节点不提供 /code（note 只有一份，别顶掉原备注）', async ({ page }) => {
  await openOutline(page, [{ id: 'a', text: 'root ', note: '已有备注', children: [] }]);
  await focusText(page, 'a', 5); // 词首：`/` 前必须是空白，否则根本不触发菜单
  await page.keyboard.type('/code');
  await expect(page.locator('.slash-menu .slash-empty')).toBeVisible();
});

test('Esc 关闭菜单；/ 后接无关词无匹配', async ({ page }) => {
  await openOutline(page, [node('a', '')]);
  await focusText(page, 'a', 0);

  await page.keyboard.type('/');
  await expect(page.locator('.slash-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.slash-menu')).toBeHidden();

  await page.keyboard.type('zzz');
  await expect(page.locator('.slash-menu')).toBeHidden();
});

test('/ 在词中（非空白后）不触发菜单', async ({ page }) => {
  await openOutline(page, [node('a', 'http:')]);
  await focusText(page, 'a', 5);
  await page.keyboard.type('/');
  // "http:/" 里的 / 紧跟非空白，不当作命令
  await expect(page.locator('.slash-menu')).toBeHidden();
});
