// Phase 2 图片：节点正文内图片预览、独立成行图片块、镜像/块引用不误判为图片。
// 0.4.0：粘贴图片（写盘 + 插入 ![[name]]）。
import { expect, test } from '@playwright/test';
import { CONFIG, HARNESS, clearPosted, focusText, inject, node, openOutline, posted } from './support.js';

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

  // 关键回归：嵌入引用必须经 store 发出 edit(setText) 抵达 host —— 老实现用 execCommand
  // 在 VS Code webview 里静默失败，图写了盘但正文没引用（真机复现过）。
  await page.waitForFunction(
    () =>
      (window as never as { __posted: { type: string; ops?: { op: string; text?: string }[] }[] }).__posted.some(
        (m) =>
          m.type === 'edit' &&
          (m.ops ?? []).some((o) => o.op === 'setText' && /cover!\[\[pasted-.*\.png\]\]/.test(o.text ?? '')),
      ),
    undefined,
    { timeout: 3000 },
  );

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
  // BUG-005：预览请求早于写盘会 404 被缓存，imageSaved 必须给 img 打 cache-bust 强制重载
  await expect(img).toHaveAttribute('src', /\?saved=/);
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

test('嵌套节点上打 ```ts 回车 → 代码块挂到该节点下（note 围栏块），节点保留', async ({ page }) => {
  await openOutline(page, [node('a', 'root', [node('a1', '')])]);
  await focusText(page, 'a1', 0);
  await clearPosted(page);
  await page.keyboard.type('```ts');
  await page.keyboard.press('Enter');

  const area = page.locator('.node[data-id="a1"] > .node-row > .node-code textarea.code-input');
  await expect(area).toHaveCount(1);
  await expect(area).toBeFocused();
  await expect(page.locator('.node[data-id="a1"] > .node-row > .node-code .code-lang')).toHaveText('ts');
  await expect(page.locator('.node[data-id="a1"]')).toHaveCount(1); // 节点没被吃掉

  // 一次 dispatchAll：setText('') + setNote(围栏) 同属一条 edit（= 一个 undo 步）。
  // 打字那条 edit 先占住 inFlight，ack 排空队列后才轮到这条。
  await inject(page, { type: 'ack', seq: 1, version: 2 });
  await page.waitForFunction(
    () =>
      (window as never as { __posted: { type: string; ops?: { op: string }[] }[] }).__posted.some(
        (m) => m.type === 'edit' && (m.ops ?? []).some((o) => o.op === 'setNote'),
      ),
    undefined,
    { timeout: 3000 },
  );
  const edit = (await posted(page)).filter((m) => m.type === 'edit').at(-1) as {
    ops: { op: string; note?: string }[];
  };
  expect(edit.ops.map((o) => o.op)).toEqual(['setText', 'setNote']);
  expect(edit.ops[1].note).toBe('```ts\n```');
});

test('节点代码块：编辑经 setNote 上报（保留首尾围栏），空块 Backspace 摘掉代码块', async ({
  page,
}) => {
  await openOutline(page, [{ id: 'a', text: 'root', note: '```js\nconst x = 1;\n```', children: [] }]);

  const area = page.locator('.node[data-id="a"] > .node-code textarea.code-input');
  await expect(area).toHaveValue('const x = 1;');
  await area.fill('const y = 2;\n\nconst z = 3;'); // 含空行：parser 侧已支持（见 docs/03）
  await page.waitForFunction(
    () =>
      (window as never as { __posted: { type: string; ops?: { op: string; note?: string }[] }[] }).__posted.some(
        (m) =>
          m.type === 'edit' &&
          (m.ops ?? []).some(
            (o) => o.op === 'setNote' && o.note === '```js\nconst y = 2;\n\nconst z = 3;\n```',
          ),
      ),
    undefined,
    { timeout: 3000 },
  );

  await inject(page, { type: 'ack', seq: 1, version: 2 });
  await area.fill('');
  await area.focus();
  await page.keyboard.press('Backspace');
  await expect(page.locator('.node[data-id="a"] > .node-code')).toHaveCount(0);
  await expect(page.locator('.node[data-id="a"]')).toHaveCount(1);
});

test('代码块节点（正文为空）：代码块排进节点行内，上方不留空行', async ({ page }) => {
  await openOutline(page, [
    { id: 'a', text: '', note: '```js\nconst x = 1;\n```', children: [] },
    { id: 'b', text: '有标题', note: '```js\nconst y = 2;\n```', children: [] },
  ]);

  // 正文为空 → 块在行内；正文有字 → 块仍在行下方（那时代码是附加内容）
  await expect(page.locator('.node[data-id="a"] > .node-row > .node-code')).toHaveCount(1);
  await expect(page.locator('.node[data-id="b"] > .node-row > .node-code')).toHaveCount(0);
  await expect(page.locator('.node[data-id="b"] > .node-code')).toHaveCount(1);

  const geom = await page.evaluate(() => {
    const box = (sel: string): DOMRect => document.querySelector(sel)!.getBoundingClientRect();
    const rowA = box('.node[data-id="a"] > .node-row');
    const codeA = box('.node[data-id="a"] .node-code');
    return { rowH: rowA.height, codeH: codeA.height, offset: codeA.top - rowA.top };
  });
  // 行高就是代码块的高度（不再多出一条 22px 的空 bullet 行）
  expect(geom.rowH - geom.codeH).toBeLessThanOrEqual(8);
  expect(geom.offset).toBeLessThanOrEqual(6);
});

test('节点代码块内 Cmd/Ctrl+Enter 在其后新建同级节点并聚焦', async ({ page }) => {
  await openOutline(page, [
    { id: 'a', text: 'root', note: '```\n```', children: [] },
    node('b', 'after'),
  ]);
  await page.locator('.node[data-id="a"] > .node-code textarea.code-input').focus();
  await page.keyboard.press('ControlOrMeta+Enter');

  await expect(page.locator('.node')).toHaveCount(3);
  const info = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    const nodeEl = active?.closest('.node');
    const a = document.querySelector('.node[data-id="a"]');
    return {
      field: active?.getAttribute('data-field'),
      afterA: a && nodeEl ? !!(a.compareDocumentPosition(nodeEl) & Node.DOCUMENT_POSITION_FOLLOWING) : false,
    };
  });
  expect(info.field).toBe('text');
  expect(info.afterA).toBe(true);
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

/** 注入「一个列表节点 + 一个代码块」的文档。code 为代码块正文（空串 = 空块）。 */
async function injectListThenCode(page: import('@playwright/test').Page, code: string): Promise<void> {
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
            { id: 'a', text: 'a', checked: null, note: null, blockId: null, mirror: null, children: [], raw: null },
          ],
        },
        { kind: 'raw', id: 'CB', lines: ['```', ...(code ? [code] : ['']), '```'] },
      ],
    },
  });
}

test('代码块内 Cmd/Ctrl+Enter 在其后新建顶层节点并聚焦（BUG-003）', async ({ page }) => {
  await injectListThenCode(page, '');
  await page.locator('.raw-block.code-block textarea.code-input').focus();
  await page.keyboard.press('ControlOrMeta+Enter');

  // 代码块后多出一个节点，且焦点落在其正文
  await expect(page.locator('.node')).toHaveCount(2);
  const info = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    const nodeEl = active?.closest('.node');
    const block = document.querySelector('.raw-block.code-block');
    // 新节点在代码块之后
    const after =
      block && nodeEl ? !!(block.compareDocumentPosition(nodeEl) & Node.DOCUMENT_POSITION_FOLLOWING) : false;
    return { field: active?.getAttribute('data-field'), after };
  });
  expect(info.field).toBe('text');
  expect(info.after).toBe(true);
});

test('空代码块 Backspace 删除整个代码块，焦点落到相邻节点（BUG-004）', async ({ page }) => {
  await injectListThenCode(page, '');
  await clearPosted(page);
  await page.locator('.raw-block.code-block textarea.code-input').focus();
  await page.keyboard.press('Backspace');

  await expect(page.locator('.raw-block.code-block')).toHaveCount(0);
  await expect(page.locator('.node[data-id="a"]')).toHaveCount(1);
  await page.waitForFunction(
    () =>
      (window as never as { __posted: { type: string; ops?: { op: string }[] }[] }).__posted.some(
        (m) => m.type === 'edit' && (m.ops ?? []).some((o) => o.op === 'deleteRawBlock'),
      ),
    undefined,
    { timeout: 3000 },
  );
});

test('非空代码块 Backspace 不删块（只删字符）', async ({ page }) => {
  await injectListThenCode(page, 'x');
  const area = page.locator('.raw-block.code-block textarea.code-input');
  await area.focus();
  // 光标移到末尾再 Backspace：删掉字符 x，代码块仍在
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await expect(page.locator('.raw-block.code-block')).toHaveCount(1);
});

// ---------- 0.7.0 图片体验 ----------

test('图片节点不显示源码：正文只有图片语法时 .text 透明，聚焦才现形', async ({ page }) => {
  await openOutline(page, [node('a', `![](${PNG})`), node('b', `说明 ![](${PNG})`)]);

  await expect(page.locator('.node[data-id="a"] > .node-row')).toHaveClass(/image-only/);
  await expect(page.locator('.node[data-id="b"] > .node-row')).not.toHaveClass(/image-only/);

  const opacityOf = (id: string): Promise<string> =>
    page
      .locator(`.node[data-id="${id}"] > .node-row > [data-field="text"]`)
      .evaluate((el) => getComputedStyle(el).opacity);
  expect(await opacityOf('a')).toBe('0');
  expect(await opacityOf('b')).toBe('1');

  // 图片挂进行内，不在正文上方多出一条空行；正文有字的节点仍挂在行下方
  await expect(page.locator('.node[data-id="a"] > .node-row > .node-images')).toHaveCount(1);
  await expect(page.locator('.node[data-id="a"] > .node-images')).toHaveCount(0);
  await expect(page.locator('.node[data-id="b"] > .node-images')).toHaveCount(1);
  await expect(page.locator('.node[data-id="b"] > .node-row > .node-images')).toHaveCount(0);

  // 行高不再被空正文撑出额外一行：整行高度就是图片那一行
  const rowH = await page
    .locator('.node[data-id="a"] > .node-row')
    .evaluate((el) => el.getBoundingClientRect().height);
  const imgH = await page
    .locator('.node[data-id="a"] img.node-image')
    .evaluate((el) => el.getBoundingClientRect().height);
  expect(rowH).toBeLessThanOrEqual(Math.max(imgH, 22) + 8);

  // 聚焦即回到源码态，仍然可编辑（不能用 display:none —— 那样根本聚焦不上）
  await focusText(page, 'a', 0);
  expect(await opacityOf('a')).toBe('1');
  await expect(page.locator('.node[data-id="a"] > .node-row > [data-field="text"]')).toBeFocused();
});

test('点击预览图放大：浮层出现，点浮层 / Esc 关闭', async ({ page }) => {
  await openOutline(page, [node('a', `封面 ![](${PNG})`)]);

  await page.locator('.node[data-id="a"] img.node-image').click();
  const box = page.locator('.image-lightbox');
  await expect(box).toBeVisible();
  await expect(box.locator('img')).toHaveAttribute('src', PNG);

  await page.keyboard.press('Escape');
  await expect(box).toHaveCount(0);

  await page.locator('.node[data-id="a"] img.node-image').click();
  await page.locator('.image-lightbox').click();
  await expect(page.locator('.image-lightbox')).toHaveCount(0);
});

test('粘贴图片落到 <文件名>/assets/ 下（host 注入的 data-assets-dir）', async ({ page }) => {
  await openOutline(page, [node('a', '')]);
  await page.evaluate(() => {
    document.documentElement.dataset.assetsDir = 'my-note/assets';
  });
  await focusText(page, 'a', 0);

  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'clip.png', { type: 'image/png' }));
    document
      .querySelector('.node[data-id="a"] [data-field="text"]')!
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG_B64);

  await page.waitForFunction(
    () =>
      (window as never as { __posted: { type: string; name?: string }[] }).__posted.some(
        (m) => m.type === 'saveImage' && /^my-note\/assets\/pasted-.*\.png$/.test(m.name ?? ''),
      ),
    undefined,
    { timeout: 3000 },
  );
  await expect(
    page.locator('.node[data-id="a"] > .node-row > [data-field="text"]'),
  ).toContainText('![[my-note/assets/pasted-');
});

test('zoom 根标题与子节点圆点对齐（不贴最左、也不比子节点靠右）', async ({ page }) => {
  await openOutline(page, [node('a', '一级节点', [node('a1', '测试')])]);
  await page.locator('.node[data-id="a"] > .node-row > .bullet').click(); // zoom in

  const zoomed = page.locator('.list-block.zoomed');
  await expect(zoomed).toHaveCount(1);

  const geom = await page.evaluate(() => {
    const title = document.querySelector('.zoomed > .node > .node-row > [data-field="text"]')!;
    const childRow = document.querySelector('.zoomed > .node > .children > .node > .node-row')!;
    const childBullet = childRow.querySelector('.bullet')!;
    const pad = parseFloat(getComputedStyle(title).paddingLeft);
    return {
      titleGlyph: title.getBoundingClientRect().left + pad,
      // 圆点由 .bullet::before 画出，left:4px
      dot: childBullet.getBoundingClientRect().left + 4,
      rowLeft: childRow.getBoundingClientRect().left,
    };
  });
  // 标题首字对齐子节点圆点左缘
  expect(Math.abs(geom.titleGlyph - geom.dot)).toBeLessThanOrEqual(2);
  // 且确实缩进了：不贴容器最左
  expect(geom.titleGlyph - geom.rowLeft).toBeGreaterThan(8);
});
