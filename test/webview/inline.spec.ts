// 行内 Markdown：未聚焦=显示态（记号隐藏），聚焦=源码态（纯文本，光标/IME 走老路）。
// 数据层永远只存原始 Markdown —— 这里断言的全是渲染层行为。
import { expect, test, type Page } from '@playwright/test';
import { clearPosted, focusText, node, openOutline, posted } from './support.js';

const TEXT = '看 `console.log(123)`、**加粗**、==高亮== 和 [文档](https://example.com/a)';

function textEl(page: Page, id = 'a') {
  return page.locator(`.node[data-id="${id}"] > .node-row > [data-field="text"]`);
}

test('未聚焦时渲染成显示态：记号隐藏，各效果就位', async ({ page }) => {
  await openOutline(page, [node('a', TEXT)]);

  await expect(textEl(page).locator('code.md-code')).toHaveText('console.log(123)');
  await expect(textEl(page).locator('strong.md-bold')).toHaveText('加粗');
  await expect(textEl(page).locator('mark.md-mark')).toHaveText('高亮');
  await expect(textEl(page).locator('span.md-link')).toHaveText('文档');
  // 记号本身不出现在可见文本里
  const shown = await textEl(page).textContent();
  expect(shown).not.toContain('**');
  expect(shown).not.toContain('==');
  expect(shown).not.toContain('](');
});

test('聚焦即回源码态：看到完整 Markdown，且是单个纯文本节点', async ({ page }) => {
  await openOutline(page, [node('a', TEXT)]);
  await focusText(page, 'a', 0);

  await expect(textEl(page).locator('code.md-code')).toHaveCount(0);
  expect(await textEl(page).textContent()).toBe(TEXT);
  const kind = await textEl(page).evaluate((el) => ({
    children: el.childElementCount,
    text: el.firstChild?.nodeType === Node.TEXT_NODE,
  }));
  expect(kind).toEqual({ children: 0, text: true });
  const highlights = await page.evaluate(() => {
    const registry = (CSS as unknown as { highlights?: { has(name: string): boolean } }).highlights;
    return {
      code: registry?.has('outline-md-code') ?? false,
      bold: registry?.has('outline-md-bold') ?? false,
      mark: registry?.has('outline-md-mark') ?? false,
      link: registry?.has('outline-md-link') ?? false,
    };
  });
  expect(highlights).toEqual({ code: true, bold: true, mark: true, link: true });
});

test('在源码态编辑后失焦，重新渲染成显示态', async ({ page }) => {
  await openOutline(page, [node('a', 'plain'), node('b', 'other')]);
  await focusText(page, 'a', 5);
  await page.keyboard.type(' **粗**');
  await focusText(page, 'b', 0);

  await expect(textEl(page).locator('strong.md-bold')).toHaveText('粗');
});

test('点链接交给 host 打开，不进编辑态；Alt+点击照常改字', async ({ page }) => {
  await openOutline(page, [node('a', '见 [文档](https://example.com/a)')]);
  await clearPosted(page);

  await textEl(page).locator('span.md-link').click();
  expect((await posted(page)).filter((m) => m.type === 'openLink')).toEqual([
    { type: 'openLink', url: 'https://example.com/a' },
  ]);
  await expect(textEl(page)).not.toBeFocused();

  await textEl(page).locator('span.md-link').click({ modifiers: ['Alt'] });
  await expect(textEl(page)).toBeFocused();
  expect(await textEl(page).textContent()).toBe('见 [文档](https://example.com/a)');
});

test('裸链接与 <url> 也可点，url 补全 scheme', async ({ page }) => {
  await openOutline(page, [node('a', '裸 https://example.com/b 和 www.example.com/c')]);
  const links = textEl(page).locator('span.md-link');
  await expect(links).toHaveCount(2);
  expect(await links.nth(0).getAttribute('data-url')).toBe('https://example.com/b');
  expect(await links.nth(1).getAttribute('data-url')).toBe('https://www.example.com/c');
});

test('镜像行与 wiki 链接不做行内渲染（归镜像/图片层）', async ({ page }) => {
  await openOutline(page, [
    { id: 'a', text: '原节点', blockId: 'k1', children: [] },
    { id: 'm', text: '![[#^k1]]', mirror: 'k1', children: [] },
    { id: 'w', text: '见 [[某笔记]]', children: [] },
  ]);
  await expect(page.locator('.node[data-id="m"] span.md-link')).toHaveCount(0);
  await expect(page.locator('.node[data-id="w"] span.md-link')).toHaveCount(0);
  expect(await textEl(page, 'w').textContent()).toBe('见 [[某笔记]]');
});

test('打字热路径不被行内渲染打断（编辑中始终是源码态）', async ({ page }) => {
  await openOutline(page, [node('a', '**粗**')]);
  await focusText(page, 'a', 6);
  await page.keyboard.type('尾');

  expect(await textEl(page).textContent()).toBe('**粗**尾');
  await expect(textEl(page)).toBeFocused();
  await expect(textEl(page).locator('strong')).toHaveCount(0);
});

// 显示态隐藏了记号，两套坐标不等长：点击落点必须换算回源码坐标，否则越靠后错得越多。
test('点显示态文本：换回源码态后光标落在点的那个字上', async ({ page }) => {
  const src = '前 **粗体** 后缀文字';
  await openOutline(page, [node('a', src)]);

  // 点「后缀文字」里的「缀」——显示态下它前面是「前 粗体 后」，源码里前面多了 4 个 * 号
  const box = await textEl(page).evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const i = (n.textContent ?? '').indexOf('缀');
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + 1);
        const rect = r.getBoundingClientRect();
        return { x: rect.left + 1, y: rect.top + rect.height / 2 };
      }
    }
    return null;
  });
  await page.mouse.click(box!.x, box!.y);

  const at = await page.evaluate(() => {
    const sel = window.getSelection()!;
    return { offset: sel.focusOffset, text: sel.focusNode?.textContent };
  });
  expect(at.text).toBe(src); // 已回源码态
  expect(src[at.offset]).toBe('缀'); // 落在点的那个字上
});
