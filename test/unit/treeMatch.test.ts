import { describe, expect, it } from 'vitest';
import { matchTrees } from '../../src/core/treeMatch.js';
import { parseOutline } from '../../src/core/parser.js';
import type { OutlineDoc } from '../../src/core/model.js';
import { PARSE_OPTS, flatten } from './helpers.js';

const parse = (text: string): OutlineDoc => parseOutline(text, PARSE_OPTS);

/** text → id 映射（用于断言 id 是否存活）。 */
function ids(doc: OutlineDoc): Map<string, string> {
  return new Map(flatten(doc).map((e) => [e.node.text, e.node.id]));
}

describe('matchTrees', () => {
  it('blockId 相等 → rename 后 id 仍存活', () => {
    const oldDoc = parse('- 写周报 ^k1\n- 别的\n');
    const newDoc = parse('- 改了名字 ^k1\n- 别的\n');
    const before = ids(oldDoc);
    matchTrees(oldDoc, newDoc);
    expect(ids(newDoc).get('改了名字')).toBe(before.get('写周报'));
  });

  it('文本相同 → move 后 id 存活', () => {
    const oldDoc = parse('- a\n- b\n- c\n');
    const newDoc = parse('- c\n- a\n- b\n');
    const before = ids(oldDoc);
    matchTrees(oldDoc, newDoc);
    const after = ids(newDoc);
    expect(after.get('a')).toBe(before.get('a'));
    expect(after.get('b')).toBe(before.get('b'));
    expect(after.get('c')).toBe(before.get('c'));
  });

  it('缩进变化不影响文本匹配', () => {
    const oldDoc = parse('- a\n- b\n');
    const newDoc = parse('- a\n  - b\n');
    const before = ids(oldDoc);
    matchTrees(oldDoc, newDoc);
    expect(ids(newDoc).get('b')).toBe(before.get('b'));
  });

  it('note / checked 参与内容匹配', () => {
    const oldDoc = parse('- [x] a\n  n1\n- a\n');
    const newDoc = parse('- a\n- [x] a\n  n1\n');
    const oldNodes = flatten(oldDoc).map((e) => e.node);
    matchTrees(oldDoc, newDoc);
    const newNodes = flatten(newDoc).map((e) => e.node);
    expect(newNodes[1].id).toBe(oldNodes[0].id); // [x] a + note 配到同内容的旧节点
    expect(newNodes[0].id).toBe(oldNodes[1].id);
  });

  it('重复文本按先序稳定配对', () => {
    const oldDoc = parse('- dup\n- dup\n- dup\n');
    const newDoc = parse('- dup\n- dup\n- dup\n');
    const before = flatten(oldDoc).map((e) => e.node.id);
    matchTrees(oldDoc, newDoc);
    expect(flatten(newDoc).map((e) => e.node.id)).toEqual(before);
  });

  it('新增节点保留自己的新 id，且不与复用 id 冲突', () => {
    const oldDoc = parse('- a\n- b\n');
    const newDoc = parse('- a\n- 新增\n- b\n');
    const before = ids(oldDoc);
    matchTrees(oldDoc, newDoc);
    const after = ids(newDoc);
    expect(after.get('a')).toBe(before.get('a'));
    expect(after.get('b')).toBe(before.get('b'));
    const all = [...after.values()];
    expect(new Set(all).size).toBe(all.length);
  });

  it('改文本的节点走位置启发，id 仍然存活', () => {
    const oldDoc = parse('- a\n- b\n');
    const newDoc = parse('- a\n- b 改了\n');
    const before = ids(oldDoc);
    matchTrees(oldDoc, newDoc);
    expect(ids(newDoc).get('b 改了')).toBe(before.get('b'));
  });

  it('RawBlock 内容相等 → 复用 id', () => {
    const oldDoc = parse('# 标题\n\n- a\n');
    const newDoc = parse('# 标题\n\n- a\n- b\n');
    const oldRawId = oldDoc.blocks[0].id;
    matchTrees(oldDoc, newDoc);
    expect(newDoc.blocks[0].id).toBe(oldRawId);
  });

  it('id 全局唯一性在匹配后仍成立', () => {
    const oldDoc = parse('- a\n  - b\n- c ^k1\n');
    const newDoc = parse('- c ^k1\n- a\n  - b\n- d\n');
    matchTrees(oldDoc, newDoc);
    const all = [...flatten(newDoc).map((e) => e.node.id), ...newDoc.blocks.map((b) => b.id)];
    expect(new Set(all).size).toBe(all.length);
  });
});
