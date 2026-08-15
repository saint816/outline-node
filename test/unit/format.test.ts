import { describe, expect, it } from 'vitest';
import { looksLikeUrl, parseLink, setLink, toggleLink, toggleMarker } from '../../src/webview/format.js';

describe('toggleMarker', () => {
  it('给选区加标记，选中的仍是内容', () => {
    expect(toggleMarker('abc def', 4, 7, '**')).toEqual({ text: 'abc **def**', start: 6, end: 9 });
  });

  it('选区两侧紧邻标记 → 去掉（再按一次取消）', () => {
    // "abc **def**" 里选中 def
    expect(toggleMarker('abc **def**', 6, 9, '**')).toEqual({ text: 'abc def', start: 4, end: 7 });
  });

  it('选区自身就是 **def** → 去掉', () => {
    expect(toggleMarker('abc **def**', 4, 11, '**')).toEqual({ text: 'abc def', start: 4, end: 7 });
  });

  it('空选区插入一对标记，光标落中间', () => {
    expect(toggleMarker('abc', 3, 3, '==')).toEqual({ text: 'abc====', start: 5, end: 5 });
  });

  it('反向选区（end < start）照常处理', () => {
    expect(toggleMarker('abc def', 7, 4, '`')).toEqual({ text: 'abc `def`', start: 5, end: 8 });
  });

  it('不同标记互不干扰，可以叠加', () => {
    const bold = toggleMarker('abc', 0, 3, '**');
    expect(toggleMarker(bold.text, bold.start, bold.end, '==')).toEqual({
      text: '**==abc==**',
      start: 4,
      end: 7,
    });
  });
});

describe('toggleLink', () => {
  it('选区变链接，url 为空时光标停在括号里等着粘地址', () => {
    // "看 [文档](" 长度 7 —— 光标落在这里，正好在括号内
    expect(toggleLink('看 文档 吧', 2, 4)).toEqual({ text: '看 [文档]() 吧', start: 7, end: 7 });
  });

  it('带 url 时光标落到整条链接之后', () => {
    const r = toggleLink('看 文档 吧', 2, 4, 'https://a.b');
    expect(r.text).toBe('看 [文档](https://a.b) 吧');
    expect(r.start).toBe(r.end);
    expect(r.text.slice(0, r.start)).toBe('看 [文档](https://a.b)');
  });

  it('选中整个链接 → 还原成纯文字', () => {
    const src = '看 [文档](https://a.b) 吧';
    expect(toggleLink(src, 2, src.indexOf(')') + 1)).toEqual({
      text: '看 文档 吧',
      start: 2,
      end: 4,
    });
  });

  it('选中整个链接又给了新 url → 换地址而不是还原（粘贴覆盖）', () => {
    const src = '看 [文档](https://a.b) 吧';
    const r = toggleLink(src, 2, src.indexOf(')') + 1, 'https://c.d');
    expect(r.text).toBe('看 [文档](https://c.d) 吧');
    expect(r.start).toBe(r.end);
  });
});

describe('链接编辑框纯逻辑', () => {
  it('解析完整 Markdown 链接', () => {
    expect(parseLink('[标题](https://example.com)')).toEqual({ title: '标题', url: 'https://example.com' });
    expect(parseLink('前缀 [标题](url)')).toBeNull();
  });

  it('用可编辑标题和 URL 替换选区', () => {
    expect(setLink('看 旧文 吧', 2, 4, { title: '新文', url: 'https://example.com' })).toEqual({
      text: '看 [新文](https://example.com) 吧',
      start: 27,
      end: 27,
    });
  });
});

describe('looksLikeUrl', () => {
  it('认带协议的单个 token 和 www. 前缀', () => {
    expect(looksLikeUrl('https://a.b/c?d=1')).toBe(true);
    expect(looksLikeUrl('  http://a.b  ')).toBe(true);
    expect(looksLikeUrl('mailto:x@y.z')).toBe(true);
    expect(looksLikeUrl('www.example.com')).toBe(true);
  });

  it('从严：普通文字、带空格的串、裸域名一律不认', () => {
    expect(looksLikeUrl('')).toBe(false);
    expect(looksLikeUrl('看这里')).toBe(false);
    expect(looksLikeUrl('https://a.b 还有别的字')).toBe(false);
    expect(looksLikeUrl('example.com')).toBe(false); // 裸域名太容易误判，走普通粘贴
    expect(looksLikeUrl('www.x')).toBe(false);
  });
});
