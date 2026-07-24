// Phase 2 图片：节点正文内图片预览、独立成行图片块、镜像/块引用不误判为图片。
// 0.4.0：粘贴图片（写盘 + 插入 ![[name]]）。
import { expect, test } from '@playwright/test';
import { CONFIG, HARNESS, focusText, inject, node, openOutline, posted } from './support.js';

// 1×1 透明 PNG（无空格 / 无右括号，可安全放进 ![](...)）
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG = `data:image/png;base64,${PNG_B64}`;

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

test('粘贴图片：光标处插入 ![[pasted-…]]，发出带 base64 的 saveImage；imageSaved 后预览出现', async ({
  page,
}) => {
  await openOutline(page, [node('a', 'cover')]);
  await focusText(page, 'a', 5);

  // 合成一次带 PNG 文件的 paste 事件
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'clip.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const el = document.querySelector('.node[data-id="a"] [data-field="text"]') as HTMLElement;
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, PNG_B64);

  // 光标处插入了嵌入语法
  await expect(
    page.locator('.node[data-id="a"] > .node-row > [data-field="text"]'),
  ).toContainText('![[pasted-');

  // 发出 saveImage（文件名 + 非空 base64）
  await page.waitForFunction(
    () =>
      (
        window as never as { __posted: { type: string; name?: string; dataBase64?: string }[] }
      ).__posted.some(
        (m) =>
          m.type === 'saveImage' &&
          /^pasted-.*\.png$/.test(m.name ?? '') &&
          (m.dataBase64?.length ?? 0) > 0,
      ),
    undefined,
    { timeout: 3000 },
  );
  const saveMsg = (await posted(page)).find((m) => m.type === 'saveImage') as { name: string };

  // host 回 imageSaved → 重渲染，预览 <img> 出现（源码仍留在正文）
  await inject(page, { type: 'imageSaved', name: saveMsg.name });
  const img = page.locator('.node[data-id="a"] .node-images img.node-image');
  await expect(img).toHaveCount(1);
  await expect(img).toHaveAttribute('src', new RegExp(saveMsg.name.replace(/\./g, '\\.')));
});

test('顶层空根节点打 ```lang 回车 → 转成代码块并聚焦，其余节点保留', async ({ page }) => {
  await openOutline(page, [node('a', ''), node('b', 'after')]);
  await focusText(page, 'a', 0);
  await page.keyboard.type('```js');
  await page.keyboard.press('Enter');

  const area = page.locator('.raw-block.code-block textarea.code-input');
  await expect(area).toHaveCount(1);
  await expect(area).toBeFocused();
  await expect(area).toHaveValue('');
  await expect(page.locator('.raw-block.code-block .code-lang')).toHaveText('js');
  // a 被消费、b 保留（DOM 结构即 toCodeBlock 的乐观应用结果）
  await expect(page.locator('.node[data-id="a"]')).toHaveCount(0);
  await expect(page.locator('.node[data-id="b"]')).toHaveCount(1);
});

test('嵌套节点上打 ``` 回车不转代码块（代码块只能顶层）', async ({ page }) => {
  await openOutline(page, [node('a', 'root', [node('a1', '')])]);
  await focusText(page, 'a1', 0);
  await page.keyboard.type('```');
  await page.keyboard.press('Enter');

  // 没有代码块产生；a1 仍是普通节点（回车按普通逻辑走）
  await expect(page.locator('.raw-block.code-block')).toHaveCount(0);
});

test('镜像块引用 / 非图 wiki 嵌入不被当作图片', async ({ page }) => {
  await openOutline(page, [node('a', 'ref ![[#^abc123]]'), node('b', 'see ![[some-note]]')]);
  await expect(page.locator('.node-images')).toHaveCount(0);
});

test('围栏代码块渲染成代码块：隐藏 ``` 围栏、显示语言标签', async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => (window as never as { __posted: unknown[] }).__posted.length > 0);
  await inject(page, {
    type: 'init',
    version: 1,
    foldedKeys: [],
    config: CONFIG,
    snapshot: {
      indentUnit: { kind: 'space', width: 2 },
      blocks: [{ kind: 'raw', id: 'r1', lines: ['```js', 'const x = 1;', 'console.log(x);', '```'] }],
    },
  });

  const block = page.locator('.raw-block.code-block');
  await expect(block).toHaveCount(1);
  await expect(block.locator('.code-lang')).toHaveText('js');
  // 正文在可编辑 textarea 里，围栏行不出现
  await expect(block.locator('textarea.code-input')).toHaveValue('const x = 1;\nconsole.log(x);');
});

test('编辑代码块正文：改动经 setRawBlock 上报，保留首尾围栏', async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => (window as never as { __posted: unknown[] }).__posted.length > 0);
  await inject(page, {
    type: 'init',
    version: 1,
    foldedKeys: [],
    config: CONFIG,
    snapshot: {
      indentUnit: { kind: 'space', width: 2 },
      blocks: [{ kind: 'raw', id: 'r1', lines: ['```js', 'const x = 1;', '```'] }],
    },
  });

  const area = page.locator('.raw-block.code-block textarea.code-input');
  await area.fill('const y = 2;');

  await page.waitForFunction(
    () =>
      (
        window as never as { __posted: { type: string; ops?: { op: string; lines?: string[] }[] }[] }
      ).__posted.some(
        (m) =>
          m.type === 'edit' &&
          (m.ops ?? []).some(
            (o) => o.op === 'setRawBlock' && (o.lines ?? []).join('\n') === '```js\nconst y = 2;\n```',
          ),
      ),
    undefined,
    { timeout: 3000 },
  );
});
