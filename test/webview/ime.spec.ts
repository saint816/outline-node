// 红线 4：IME 守卫。中文输入丢字是最高优先级 bug，这里用 CDP 驱动真实组合事件。
import { expect, test, type Page } from '@playwright/test';
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

async function ime(page: Page) {
  const client = await page.context().newCDPSession(page);
  return {
    /** 输入法候选中（未上屏）。 */
    compose: async (text: string) => {
      await client.send('Input.imeSetComposition', {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
    },
    /** 上屏（commit）。 */
    commit: async (text: string) => {
      await client.send('Input.insertText', { text });
    },
  };
}

const edits = async (page: Page) => (await posted(page)).filter((m) => m.type === 'edit');

test('拼音候选期间不发 setText，上屏后文本完整', async ({ page }) => {
  await openOutline(page, [node('a', '')]);
  await focusText(page, 'a', 0);
  await clearPosted(page);
  const input = await ime(page);

  await input.compose('n');
  await input.compose('ni');
  await input.compose('niha');
  await input.compose('nihao');
  await page.waitForTimeout(500); // 超过 setText 防抖窗口

  expect(await edits(page)).toEqual([]); // 组合期间一条都不能发

  await input.commit('你好');
  const edit = await waitForEdit(page);
  expect(edit.ops).toEqual([{ op: 'setText', id: 'a', text: '你好' }]);
  expect(await textsInDom(page)).toEqual(['你好']);
});

test('长句连续上屏零丢字零重复', async ({ page }) => {
  await openOutline(page, [node('a', '')]);
  await focusText(page, 'a', 0);
  await clearPosted(page);
  const input = await ime(page);

  const words = ['今天', '天气', '真不错', '，', '出去', '走走'];
  for (const word of words) {
    await input.compose(word.slice(0, 1));
    await input.compose(word);
    await input.commit(word);
    await page.waitForTimeout(30);
  }

  await page.waitForTimeout(500);
  expect(await textsInDom(page)).toEqual(['今天天气真不错，出去走走']);
  const last = (await edits(page)).at(-1)!;
  expect(last.ops).toEqual([{ op: 'setText', id: 'a', text: '今天天气真不错，出去走走' }]);
});

test('组合期间收到 refresh：DOM 不被触碰，上屏后才应用', async ({ page }) => {
  await openOutline(page, [node('a', ''), node('b', 'beta')]);
  await focusText(page, 'a', 0);
  await clearPosted(page);
  const input = await ime(page);

  await input.compose('zhong');
  await input.compose('zhongwen');

  await inject(page, {
    type: 'refresh',
    version: 7,
    cause: 'external',
    snapshot: snapshot([node('a', ''), node('b', 'beta'), node('c', '外部新增')]),
  });
  await page.waitForTimeout(300);

  // 正在组合的节点 DOM 原封不动，refresh 被搁置（还没多出第三个节点）
  expect(await page.locator('.node').count()).toBe(2);
  const composing = await page.locator('.node[data-id="a"] [data-field="text"]').textContent();
  expect(composing).toBe('zhongwen');
  expect(await caretState(page)).toMatchObject({ id: 'a' });

  await input.commit('中文');
  await expect(page.locator('.node')).toHaveCount(3);
  expect(await textsInDom(page)).toEqual(['中文', 'beta', '外部新增']);

  // 上屏的文本没有被 refresh 吃掉，而是作为新的 setText 补发
  const edit = await waitForEdit(page);
  expect(edit).toMatchObject({ baseVersion: 7, ops: [{ op: 'setText', id: 'a', text: '中文' }] });
});

test('组合期间的 Enter/Backspace 让给输入法，不触发结构 op', async ({ page }) => {
  await openOutline(page, [node('a', 'x'), node('b', 'y')]);
  await focusText(page, 'b', 0);
  await clearPosted(page);
  const input = await ime(page);

  await input.compose('hao');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);

  expect(await edits(page)).toEqual([]);
  expect(await page.locator('.node').count()).toBe(2);

  await input.commit('好');
  await page.waitForTimeout(400);
  const last = (await edits(page)).at(-1)!;
  expect(last.ops).toEqual([{ op: 'setText', id: 'b', text: '好y' }]);
});
