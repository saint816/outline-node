import { describe, expect, it } from 'vitest';
import { nodeKey, nodeKeys } from '../../src/core/nodeKey.js';
import { parseOutline } from '../../src/core/parser.js';
import { applyOp } from '../../src/core/ops.js';
import { PARSE_OPTS, flatten } from './helpers.js';

const parse = (text: string) => parseOutline(text, PARSE_OPTS);

describe('nodeKey', () => {
  it('blockId 优先', () => {
    const doc = parse('- 写周报 ^k3f9a2\n');
    expect(nodeKey(flatten(doc)[0].node, 0)).toBe('b:k3f9a2');
  });

  it('无 blockId 用文本哈希，重复文本按先序加序号', () => {
    const doc = parse('- dup\n- other\n- dup\n- dup\n');
    const keys = nodeKeys(doc.blocks);
    const [d1, other, d2, d3] = flatten(doc).map((e) => keys.get(e.node.id));
    expect(d1).toMatch(/^h:[0-9a-z]+$/);
    expect(d2).toBe(`${d1}#1`);
    expect(d3).toBe(`${d1}#2`);
    expect(other).not.toBe(d1);
  });

  it('key 不含祖先路径：indent / move 之后不变（折叠因此存活）', () => {
    const doc = parse('- a\n- b\n  - c\n');
    const before = nodeKeys(doc.blocks);
    const b = flatten(doc).find((e) => e.node.text === 'b')!.node;
    applyOp(doc, { op: 'indent', id: b.id });
    const after = nodeKeys(doc.blocks);
    for (const [id, key] of before) expect(after.get(id)).toBe(key);
  });

  it('rename 使 key 失效，但带 blockId 的节点免疫', () => {
    const doc = parse('- plain\n- withid ^k1\n');
    const before = nodeKeys(doc.blocks);
    const [plain, withId] = flatten(doc).map((e) => e.node);
    applyOp(doc, { op: 'setText', id: plain.id, text: 'renamed' });
    applyOp(doc, { op: 'setText', id: withId.id, text: 'renamed too' });
    const after = nodeKeys(doc.blocks);
    expect(after.get(plain.id)).not.toBe(before.get(plain.id));
    expect(after.get(withId.id)).toBe('b:k1');
  });

  it('跨解析稳定：同样的文本得到同样的 key', () => {
    const text = '- a\n  - b\n- a\n';
    const first = [...nodeKeys(parse(text).blocks).values()];
    const second = [...nodeKeys(parse(text).blocks).values()];
    expect(second).toEqual(first);
  });
});
