// 选区排版：浮动工具条 + 快捷键。两条路径最终都落到同一段纯逻辑（format.ts，单测覆盖），
// 这里只验 DOM 侧：工具条的出现/消失、选区保持、写回 store。
import { expect, test, type Page } from '@playwright/test';
import { clearPosted, focusText, inject, node, openOutline } from './support.js';

function textEl(page: Page, id = 'a') {
  return page.locator(`.node[data-id="${id}"] > .node-row > [data-field="text"]`);
}

/** 选中正文里 [start, end) 的字符。 */
async function selectText(page: Page, id: string, start: number, end: number): Promise<void> {
  await page.evaluate(
    ({ id, start, end }) => {
      const el = document.querySelector<HTMLElement>(`.node[data-id="${id}"] [data-field="text"]`)!;
      el.focus();
      const textNode = el.firstChild!;
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, end);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    },
    { id, start, end },
  );
}

test('选中文字弹出工具条，光标折叠后收起', async ({ page }) => {
  await openOutline(page, [node('a', 'abc def')]);
  await expect(page.locator('.format-bar')).toBeHidden();

  await selectText(page, 'a', 4, 7);
  await expect(page.locator('.format-bar')).toBeVisible();

  await focusText(page, 'a', 0); // 折叠选区
  await expect(page.locator('.format-bar')).toBeHidden();
});

test('点加粗：写回 **…**，选区仍在内容上，且发出 setText', async ({ page }) => {
  await openOutline(page, [node('a', 'abc def')]);
  await selectText(page, 'a', 4, 7);
  await clearPosted(page);

  await page.locator('.format-bold').click();
  await expect(textEl(page)).toHaveText('abc **def**');

  // 选中的仍是 def（不含标记），可以接着点高亮叠加
  const sel = await page.evaluate(() => window.getSelection()?.toString());
  expect(sel).toBe('def');

  await page.locator('.format-mark').click();
  await expect(textEl(page)).toHaveText('abc **==def==**');

  await inject(page, { type: 'ack', seq: 1, version: 2 });
  await page.waitForFunction(() =>
    (window as never as { __posted: { type: string; ops?: { op: string; text?: string }[] }[] }).__posted.some(
      (m) => m.type === 'edit' && (m.ops ?? []).some((o) => o.op === 'setText' && o.text === 'abc **==def==**'),
    ),
  );
});

test('再点一次取消（选区两侧就是标记）', async ({ page }) => {
  await openOutline(page, [node('a', 'abc **def**')]);
  await selectText(page, 'a', 6, 9); // 选中 def
  await page.locator('.format-bold').click();
  await expect(textEl(page)).toHaveText('abc def');
});

test('点链接弹出双输入框，标题默认选中文字，提交后光标落在链接末尾', async ({ page }) => {
  await openOutline(page, [node('a', '看 文档 吧')]);
  await selectText(page, 'a', 2, 4);
  await page.locator('.format-link').click();

  const inputs = page.locator('.link-popover-input');
  await expect(inputs.nth(0)).toHaveValue('文档');
  await expect(inputs.nth(1)).toBeFocused();
  await inputs.nth(1).fill('https://example.com');
  await page.keyboard.press('Enter');
  await expect(textEl(page)).toHaveText('看 [文档](https://example.com) 吧');
  const offset = await page.evaluate(() => window.getSelection()?.focusOffset);
  expect(offset).toBe('看 [文档](https://example.com)'.length);
});

test('链接弹层可编辑现有链接，Esc 取消时恢复原选区', async ({ page }) => {
  const source = '看 [旧标题](https://old.example) 吧';
  await openOutline(page, [node('a', source)]);
  await selectText(page, 'a', 2, source.length - 2);
  await page.locator('.format-link').click();
  const inputs = page.locator('.link-popover-input');
  await expect(inputs.nth(0)).toHaveValue('旧标题');
  await expect(inputs.nth(1)).toHaveValue('https://old.example');
  await page.keyboard.press('Escape');
  await expect(page.locator('.link-popover')).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('[旧标题](https://old.example)');
});

test('mac 快捷键 Ctrl+B / Ctrl+H 施加加粗与高亮', async ({ page }) => {
  await openOutline(page, [node('a', 'abc def')]);
  await selectText(page, 'a', 4, 7);

  await page.keyboard.press('Control+b');
  await expect(textEl(page)).toHaveText('abc **def**');

  await page.keyboard.press('Control+h');
  await expect(textEl(page)).toHaveText('abc **==def==**');
});

test('非 mac 平台走 Ctrl+Alt+B，裸 Ctrl+B 不触发（那是 VS Code 的切换侧边栏）', async ({ page }) => {
  await openOutline(page, [node('a', 'abc def')]);
  await page.evaluate(() => document.documentElement.setAttribute('data-platform', 'win'));
  await selectText(page, 'a', 4, 7);

  await page.keyboard.press('Control+b');
  await expect(textEl(page)).toHaveText('abc def');

  // Ctrl+B 不归我们管，浏览器（macOS 的 Emacs 键位）会拿它移光标 → 选区没了，重选一次
  await selectText(page, 'a', 4, 7);
  await page.keyboard.press('Control+Alt+b');
  await expect(textEl(page)).toHaveText('abc **def**');
});

/** 合成一次纯文本 paste。 */
async function pasteText(page: Page, id: string, text: string): Promise<void> {
  await page.evaluate(
    ({ id, text }) => {
      const el = document.querySelector<HTMLElement>(`.node[data-id="${id}"] [data-field="text"]`)!;
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { id, text },
  );
}

test('选中文字时粘贴 URL → 直接变成 [文字](url)', async ({ page }) => {
  await openOutline(page, [node('a', '看 文档 吧')]);
  await selectText(page, 'a', 2, 4);

  await pasteText(page, 'a', 'https://a.b/c');
  await expect(textEl(page)).toHaveText('看 [文档](https://a.b/c) 吧');
});

test('粘贴的不是 URL、或没有选区 → 不包链接，走普通粘贴', async ({ page }) => {
  await openOutline(page, [node('a', '看 文档 吧')]);

  // 普通文字：不动
  await selectText(page, 'a', 2, 4);
  await pasteText(page, 'a', '一段普通文字');
  await expect(textEl(page)).toHaveText('看 文档 吧');

  // 是 URL 但选区折叠：不动（浏览器默认插入在真实粘贴里发生，这里合成事件不会插）
  await focusText(page, 'a', 2);
  await pasteText(page, 'a', 'https://a.b');
  await expect(textEl(page)).toHaveText('看 文档 吧');
});

test('选中已有链接时粘贴新 URL → 换地址而不是还原成纯文字', async ({ page }) => {
  await openOutline(page, [node('a', '看 [文档](https://a.b) 吧')]);
  await selectText(page, 'a', 2, 19); // 选中整条 [文档](https://a.b)
  await pasteText(page, 'a', 'https://c.d');
  await expect(textEl(page)).toHaveText('看 [文档](https://c.d) 吧');
});

test('工具条按钮不抢焦点（按下时选区还在）', async ({ page }) => {
  await openOutline(page, [node('a', 'abc def')]);
  await selectText(page, 'a', 4, 7);
  await page.locator('.format-bold').click();

  await expect(textEl(page)).toBeFocused();
});
