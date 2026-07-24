// Phase 3 有序列表（Number 类型）：编号显示、Cmd/Ctrl+Shift+7 切换。
import { expect, test } from '@playwright/test';
import { CONFIG, HARNESS, focusText, inject } from './support.js';

interface PostedWindow {
  __posted: { type: string }[];
}

function orderedNode(id: string, text: string, num: number | null) {
  return {
    id,
    text,
    checked: null,
    ...(num !== null ? { ordered: { delim: '.', num } } : {}),
    note: null,
    blockId: null,
    mirror: null,
    children: [],
    raw: null,
  };
}

async function open(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(HARNESS);
  await page.waitForFunction(() => (window as never as PostedWindow).__posted.length > 0);
  await inject(page, {
    type: 'init',
    version: 1,
    foldedKeys: [],
    config: CONFIG,
    snapshot: {
      indentUnit: { kind: 'space', width: 2 },
      blocks: [
        {
          kind: 'list',
          id: 'l1',
          roots: [
            orderedNode('a', '第一', 1),
            orderedNode('b', '第二', 2),
            orderedNode('c', '普通', null),
          ],
        },
      ],
    },
  });
  await page.waitForSelector('.node');
}

test('有序项在 bullet 位显示编号，普通节点不显示', async ({ page }) => {
  await open(page);
  await expect(page.locator('.node[data-id="a"] > .node-row.ordered > .bullet')).toHaveText('1.');
  await expect(page.locator('.node[data-id="b"] > .node-row.ordered > .bullet')).toHaveText('2.');
  await expect(page.locator('.node[data-id="c"] > .node-row.ordered')).toHaveCount(0);
});

test('Cmd/Ctrl+Shift+7 把普通节点切成有序（接续前驱编号）', async ({ page }) => {
  await open(page);
  await focusText(page, 'c', 0);
  await page.keyboard.press('Control+Shift+Digit7');

  // c 的前驱 b 是 2. → c 变成 3.
  await expect(page.locator('.node[data-id="c"] > .node-row.ordered > .bullet')).toHaveText('3.');
  // 上报了 edit（含 toggleOrdered op）
  await page.waitForFunction(
    () => (window as never as PostedWindow).__posted.some((m) => m.type === 'edit'),
    undefined,
    { timeout: 3000 },
  );
});
