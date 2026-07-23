import { describe, expect, it } from 'vitest';
import { detectIndent, indentWidth } from '../../src/core/indent.js';
import { loadFixture } from './helpers.js';

const linesOf = (text: string): string[] => text.split('\n');

describe('detectIndent', () => {
  it('取相邻父子缩进差的众数', () => {
    expect(detectIndent(linesOf('- a\n  - b\n    - c\n'))).toEqual({ kind: 'space', width: 2 });
    expect(detectIndent(linesOf('- a\n    - b\n        - c\n'))).toEqual({
      kind: 'space',
      width: 4,
    });
    expect(detectIndent(linesOf('- a\n   - b\n      - c\n'))).toEqual({ kind: 'space', width: 3 });
  });

  it('众数而非首个：少数派缩进不影响结果', () => {
    const text = '- a\n    - b\n- c\n  - d\n- e\n  - f\n';
    expect(detectIndent(linesOf(text))).toEqual({ kind: 'space', width: 2 });
  });

  it('任一列表行含 tab → tab 优先', () => {
    expect(detectIndent(linesOf('- a\n  - b\n- c\n\t- d\n'))).toEqual({ kind: 'tab' });
    expect(detectIndent(linesOf(loadFixture('logseq-tabs.md')))).toEqual({ kind: 'tab' });
  });

  it('无列表或无父子对 → null', () => {
    expect(detectIndent(linesOf('# 标题\n正文\n'))).toBeNull();
    expect(detectIndent(linesOf('- a\n- b\n'))).toBeNull();
    expect(detectIndent([])).toBeNull();
  });

  it('忽略 frontmatter 与代码块内的伪列表行', () => {
    const text = '---\n- 这是 yaml 数组\n  - 不算缩进证据\n---\n\n```\n- x\n        - y\n```\n\n- a\n  - b\n';
    expect(detectIndent(linesOf(text))).toEqual({ kind: 'space', width: 2 });
  });
});

describe('indentWidth', () => {
  it('space 单位下 tab 折算为一级宽度', () => {
    expect(indentWidth('    ', { kind: 'space', width: 2 })).toBe(4);
    expect(indentWidth('\t', { kind: 'space', width: 4 })).toBe(4);
  });

  it('tab 单位下 tab 按 tab stop 计宽，保证 note 续行判定正确', () => {
    // `\t- x` 的内容列 = 4 + 2 = 6；note 行 `\t\tfoo` 宽 8 ≥ 6
    expect(indentWidth('\t', { kind: 'tab' })).toBe(4);
    expect(indentWidth('\t\t', { kind: 'tab' })).toBe(8);
  });
});
