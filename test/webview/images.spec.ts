// Phase 2 图片：节点正文内图片预览、独立成行图片块、镜像/块引用不误判为图片。
import { expect, test } from '@playwright/test';
import { CONFIG, HARNESS, inject, node, openOutline } from './support.js';

// 1×1 透明 PNG（无空格 / 无右括号，可安全放进 ![](...)）
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('节点正文里的 Markdown 图片渲染成预览 <img>，源码仍可编辑', async ({ page }) => {
  await openOutline(page, [node('a', `封面 ![](${PNG})`)]);

  const img = page.locator('.node[data-id="a"] .node-images img.node-image');
  await expect(img).toHaveCount(1);
  await expect(img).toHaveAttribute('src', PNG);
  // 源码仍在可编辑正文里
  await expect(page.locator('.node[data-id="a"] > .node-row > [data-field="text"]')).toHaveText(
    `封面 ![](${PNG})`,
  );
});

test('独立成行的图片渲染成图片块（raw block）', async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => (window as never as { __posted: unknown[] }).__posted.length > 0);
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
            {
              id: 'a',
              text: 'before',
              checked: null,
              note: null,
              blockId: null,
              mirror: null,
              children: [],
              raw: null,
            },
          ],
        },
        { kind: 'raw', id: 'r1', lines: [`![](${PNG})`] },
      ],
    },
  });

  await expect(page.locator('.raw-block.image-block img.node-image')).toHaveAttribute('src', PNG);
});

test('镜像块引用 / 非图 wiki 嵌入不被当作图片', async ({ page }) => {
  await openOutline(page, [node('a', 'ref ![[#^abc123]]'), node('b', 'see ![[some-note]]')]);
  await expect(page.locator('.node-images')).toHaveCount(0);
});
