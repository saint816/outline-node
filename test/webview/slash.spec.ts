// 斜杠插入菜单（/ → Code/To-do/编号）。i18n 默认 en：条目文案 Code block / To-do / Numbered list。
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

test('输入 / 在空的顶层节点弹出菜单，含 Code/To-do/Numbered', async ({ page }) => {
  await openOutline(page, [node('a', '')]);
  await focusText(page, 'a', 0);
  await page.keyboard.type('/');

  const menu = page.locator('.slash-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.slash-item')).toHaveText([/Code block/, /To-do/, /Numbered list/]);
});

test('/code + Enter：空顶层节点转成代码块并聚焦', async ({ page }) => {
  await openOutline(page, [node('a', ''), node('b', 'after')]);
  await focusText(page, 'a', 0);
  await page.keyboard.type('/code');
  await expect(page.locator('.slash-menu .slash-item')).toHaveText([/Code block/]);
  await page.keyboard.press('Enter');

  const area = page.locator('.raw-block.code-block textarea.code-input');
  await expect(area).toHaveCount(1);
  await expect(area).toBeFocused();
  await expect(page.locator('.node[data-id="a"]')).toHaveCount(0);
  await expect(page.locator('.node[data-id="b"]')).toHaveCount(1);
});

test('/todo + Enter：删掉 /todo 并把节点设为未勾选任务（setChecked false）', async ({ page }) => {
  await openOutline(page, [node('a', '')]);
  await focusText(page, 'a', 0);
  await clearPosted(page);
  await page.keyboard.type('/todo');
  await page.keyboard.press('Enter');

  // 第一条 edit 发出「/todo」占位后 inFlight，ack 排空队列才补发 setText '' + setChecked
  await inject(page, { type: 'ack', seq: 1, version: 2 });
  await waitForOp(page, 'setChecked', false);
  await expect(page.locator('.slash-menu')).toBeHidden();
  // /todo 文本被删掉，节点正文回空
  await expect(page.locator('.node[data-id="a"] > .node-row > [data-field="text"]')).toHaveText('');
});

test('/num + Enter：删掉 /num 并转有序列表（toggleOrdered）', async ({ page }) => {
  await openOutline(page, [node('a', '')]);
  await focusText(page, 'a', 0);
  await clearPosted(page);
  await page.keyboard.type('/num');
  await page.keyboard.press('Enter');

  await inject(page, { type: 'ack', seq: 1, version: 2 });
  await waitForOp(page, 'toggleOrdered');
  await expect(page.locator('.node[data-id="a"] > .node-row > [data-field="text"]')).toHaveText('');
});

test('嵌套节点上 /code 不提供代码块（仅顶层）', async ({ page }) => {
  await openOutline(page, [node('a', 'root', [node('a1', '')])]);
  await focusText(page, 'a1', 0);
  await page.keyboard.type('/code');

  // Code 被 enabled 过滤掉，query "code" 无其它匹配 → 显示占位、不产生代码块
  await expect(page.locator('.slash-menu .slash-empty')).toBeVisible();
  await page.keyboard.press('Enter'); // 无匹配时 Enter 放行为普通拆分，不转代码块
  await expect(page.locator('.raw-block.code-block')).toHaveCount(0);
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
