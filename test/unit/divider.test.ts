import { describe, it, expect } from 'vitest';
import { parseOutline } from '../../src/core/parser.js';
import { serializeOutline } from '../../src/core/serializer.js';
import { applyOp } from '../../src/core/ops.js';
import { dividerKind, canMakeDivider } from '../../src/core/divider.js';
import { PARSE_OPTS } from './helpers.js';

describe('divider Markdown', () => {
  it('preserves bytes, title, children and edited round-trip', () => {
    const input = '- before\r\n- ***\r\n- 标题\r\n  ***\r\n  - child\r\n- after\r\n';
    const doc = parseOutline(input, PARSE_OPTS);
    const block = doc.blocks[0];
    if (block.kind !== 'list') throw new Error('expected list');
    expect(block.roots.map(dividerKind)).toEqual([null, 'plain', 'title', null]);
    expect(block.roots[2].children[0].text).toBe('child');
    expect(serializeOutline(doc)).toBe(input);
    applyOp(doc, { op: 'setText', id: block.roots[2].id, text: '新标题' });
    const serialized = serializeOutline(doc);
    expect(serialized).toContain('- 新标题\r\n  ***\r\n  - child');
    expect(serializeOutline(parseOutline(serialized, PARSE_OPTS))).toBe(serialized);
  });
  it('does not classify tasks, fences, multi-line notes or ordinary text', () => {
    for (const source of ['- [ ] ***', '- x\n  ```\n  ***\n  ```', '- x\n  ***\n  more', '- a***b']) {
      const block = parseOutline(source, PARSE_OPTS).blocks[0];
      if (block.kind !== 'list') throw new Error('expected list');
      expect(dividerKind(block.roots[0])).toBeNull();
      if (block.roots[0].note || block.roots[0].checked !== null) expect(canMakeDivider(block.roots[0])).toBe(false);
    }
  });
});
