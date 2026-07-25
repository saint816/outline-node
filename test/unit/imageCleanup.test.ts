// 孤儿图片清理的纯逻辑部分（引用扫描 + assets 目录推导）。
// 真正的删除走 vscode.workspace.fs（带确认 + 废纸篓），不在单测覆盖范围。
import { describe, expect, it } from 'vitest';
import { referencedImageNames } from '../../src/extension/imageCleanup.js';
import { assetsDirFor } from '../../src/extension/outlineEditorProvider.js';

describe('referencedImageNames', () => {
  it('认出 wiki 嵌入与 markdown 图片，取最后一段文件名', () => {
    const text = [
      '- 封面 ![[notes/assets/pasted-1.png]]',
      '- 另一张 ![alt](notes/assets/pasted-2.jpg)',
      '- 裸文件名 ![[pasted-3.gif]]',
      '',
    ].join('\n');
    expect(referencedImageNames(text)).toEqual(
      new Set(['pasted-1.png', 'pasted-2.jpg', 'pasted-3.gif']),
    );
  });

  it('剥掉 Obsidian 的 |宽度 后缀，并解码百分号转义', () => {
    const names = referencedImageNames('- ![[a/b/pasted%20x.png|200]]');
    expect(names).toEqual(new Set(['pasted x.png']));
  });

  it('镜像块引用不算图片引用', () => {
    expect(referencedImageNames('- ref ![[#^abc123]]')).toEqual(new Set());
  });

  it('空文档没有引用', () => {
    expect(referencedImageNames('')).toEqual(new Set());
  });
});

describe('assetsDirFor', () => {
  const dir = (path: string): string => assetsDirFor({ path } as never);

  it('按文件名去扩展名派生 <名字>/assets', () => {
    expect(dir('/w/notes.outline.md')).toBe('notes/assets');
    expect(dir('/w/plain.md')).toBe('plain/assets');
    expect(dir('/w/中文 笔记.outline.md')).toBe('中文 笔记/assets');
  });

  it('多级目录只取最后一段', () => {
    expect(dir('/a/b/c/deep.outline.md')).toBe('deep/assets');
  });
});
