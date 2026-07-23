import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { applyEdits, minimalEdits } from '../../src/core/lineDiff.js';

const randomText = fc
  .array(fc.constantFrom('- a', '- b', '  - c', '', '# h', 'text'), { maxLength: 12 })
  .map((lines) => lines.join('\n'));

describe('minimalEdits', () => {
  it('文本相同时返回空数组', () => {
    expect(minimalEdits('', '')).toEqual([]);
    expect(minimalEdits('- a\n- b\n', '- a\n- b\n')).toEqual([]);
  });

  it('单行改动只覆盖该行', () => {
    const spans = minimalEdits('- a\n- b\n- c\n', '- a\n- B\n- c\n');
    expect(spans).toEqual([{ start: 4, end: 8, text: '- B\n' }]);
  });

  it('行尾追加只覆盖尾部', () => {
    expect(minimalEdits('- a\n', '- a\n- b\n')).toEqual([{ start: 4, end: 4, text: '- b\n' }]);
  });

  it('删除中间行', () => {
    expect(minimalEdits('- a\n- b\n- c\n', '- a\n- c\n')).toEqual([
      { start: 4, end: 8, text: '' },
    ]);
  });

  it('CRLF 文本按行裁剪', () => {
    expect(minimalEdits('- a\r\n- b\r\n', '- a\r\n- B\r\n')).toEqual([
      { start: 5, end: 10, text: '- B\r\n' },
    ]);
  });

  it('恒等式：apply(minimalEdits(a, b), a) === b', () => {
    fc.assert(
      fc.property(randomText, randomText, (a, b) => {
        expect(applyEdits(a, minimalEdits(a, b))).toBe(b);
      }),
      { numRuns: 500 },
    );
  });

  it('恒等式：任意字符串对也成立', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(applyEdits(a, minimalEdits(a, b))).toBe(b);
      }),
      { numRuns: 500 },
    );
  });
});
