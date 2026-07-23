// 镜像展开是纯函数（零 DOM），直接在 vitest 里覆盖（见 docs/06）。
import { describe, expect, it } from 'vitest';
import { parseOutline } from '../../src/core/parser.js';
import { applyOp } from '../../src/core/ops.js';
import { serializeOutline } from '../../src/core/serializer.js';
import {
  expandMirrors,
  generateBlockId,
  hasMirrors,
  mirrorLink,
  originalIdOf,
  type ViewNode,
} from '../../src/webview/mirror.js';
import { PARSE_OPTS, flatten } from './helpers.js';

const parse = (text: string) => parseOutline(text, PARSE_OPTS);

function viewRows(blocks: ReturnType<typeof expandMirrors>): [string, string, number][] {
  const out: [string, string, number][] = [];
  const walk = (nodes: ViewNode[], depth: number): void => {
    for (const n of nodes) {
      out.push([n.text, n.mirrorState ?? 'none', depth]);
      walk(n.children, depth + 1);
    }
  };
  for (const block of blocks) if (block.kind === 'list') walk(block.roots, 0);
  return out;
}

describe('expandMirrors', () => {
  it('无镜像时零拷贝返回原树', () => {
    const doc = parse('- a\n  - b\n');
    expect(hasMirrors(doc.blocks)).toBe(false);
    expect(expandMirrors(doc.blocks)).toBe(doc.blocks);
  });

  it('镜像行展开为原节点的第二个视图（含整棵子树）', () => {
    const doc = parse('- 写周报 ^k1\n  - 收集数据\n  - 汇总\n- 本周\n  - ![[#^k1]]\n');
    const view = expandMirrors(doc.blocks);

    expect(viewRows(view)).toEqual([
      ['写周报', 'none', 0],
      ['收集数据', 'none', 1],
      ['汇总', 'none', 1],
      ['本周', 'none', 0],
      // 镜像行本身被替换成原节点的视图，子树跟着展开
      ['写周报', 'mirror', 1],
      ['收集数据', 'none', 2],
      ['汇总', 'none', 2],
    ]);
  });

  it('视图内用复合 id，且能还原回数据层 id', () => {
    const doc = parse('- 原 ^k1\n  - 子\n- ![[#^k1]]\n');
    const [source, , mirrorRow] = flatten(doc).map((e) => e.node);
    const view = expandMirrors(doc.blocks);
    const block = view[0];
    if (block.kind !== 'list') throw new Error('expected list');
    const mirrored = block.roots[1];

    expect(mirrored.id).toBe(`${mirrorRow.id}/${source.id}`);
    expect(originalIdOf(mirrored.id)).toBe(source.id);
    expect(mirrored.originalId).toBe(source.id);
    // 子节点也带同一前缀，keyed map 不会与原视图冲突
    expect(mirrored.children[0].id.startsWith(`${mirrorRow.id}/`)).toBe(true);
    expect(originalIdOf(mirrored.children[0].id)).toBe(source.children[0].id);
  });

  it('断链：目标 blockId 不存在 → broken，原文保留', () => {
    const doc = parse('- 别的\n- ![[#^missing]]\n');
    const rows = viewRows(expandMirrors(doc.blocks));
    expect(rows).toEqual([
      ['别的', 'none', 0],
      ['![[#^missing]]', 'broken', 0],
    ]);
    // 数据层不动，序列化仍是原文（不静默删除）
    expect(serializeOutline(doc)).toBe('- 别的\n- ![[#^missing]]\n');
  });

  it('删除原节点后，镜像自动变断链且不丢文', () => {
    const doc = parse('- 原 ^k1\n- ![[#^k1]]\n');
    const source = flatten(doc)[0].node;
    applyOp(doc, { op: 'delete', id: source.id });

    expect(viewRows(expandMirrors(doc.blocks))).toEqual([['![[#^k1]]', 'broken', 0]]);
    expect(serializeOutline(doc)).toBe('- ![[#^k1]]\n');
  });

  it('循环引用：渲染占位符，不展开', () => {
    // 原节点的子树里放一个指向自己的镜像
    const doc = parse('- 自引用 ^k1\n  - ![[#^k1]]\n');
    expect(viewRows(expandMirrors(doc.blocks))).toEqual([
      ['自引用', 'none', 0],
      ['![[#^k1]]', 'cycle', 1],
    ]);
  });

  it('互相引用也能收敛（A 里嵌 B，B 里嵌 A）', () => {
    const doc = parse('- A ^ka\n  - ![[#^kb]]\n- B ^kb\n  - ![[#^ka]]\n');
    const rows = viewRows(expandMirrors(doc.blocks));
    expect(rows).toEqual([
      ['A', 'none', 0],
      ['B', 'mirror', 1],
      ['![[#^ka]]', 'cycle', 2],
      ['B', 'none', 0],
      ['A', 'mirror', 1],
      ['![[#^kb]]', 'cycle', 2],
    ]);
  });

  it('镜像行在文件里带子行：渲染层忽略，但数据不丢', () => {
    const text = '- 原 ^k1\n  - 子\n- ![[#^k1]]\n  - 镜像行下的子行\n';
    const doc = parse(text);
    const view = expandMirrors(doc.blocks);
    const block = view[0];
    if (block.kind !== 'list') throw new Error('expected list');

    expect(block.roots[1].ignoredChildren).toBe(true);
    expect(block.roots[1].children.map((c) => c.text)).toEqual(['子']); // 展开的是原节点子树
    expect(serializeOutline(doc)).toBe(text); // 文件里的子行原样保留
  });
});

describe('镜像链接与 blockId', () => {
  it('mirrorLink 用 Obsidian 原生块嵌入语法', () => {
    expect(mirrorLink('k3f9a2')).toBe('![[#^k3f9a2]]');
    expect(parse(`- ${mirrorLink('k3f9a2')}\n`).blocks[0]).toMatchObject({ kind: 'list' });
    expect(flatten(parse(`- ${mirrorLink('k3f9a2')}\n`))[0].node.mirror).toBe('k3f9a2');
  });

  it('generateBlockId 产出 6 位 base36 且避开已存在的 id', () => {
    const doc = parse('- a ^aaaaaa\n- b ^bbbbbb\n');
    const id = generateBlockId(doc.blocks);
    expect(id).toMatch(/^[0-9a-z]{6}$/);
    expect(['aaaaaa', 'bbbbbb']).not.toContain(id);
  });

  it('generateBlockId 撞车时重试', () => {
    const doc = parse('- a ^000000\n');
    const values = [0, 0, 1 / 36 ** 6];
    let i = 0;
    const id = generateBlockId(doc.blocks, () => values[Math.min(i++, values.length - 1)]);
    expect(id).toBe('000001');
  });
});

describe('assignBlockId op', () => {
  it('写入行尾 ^id，raw 失效后重新生成', () => {
    const doc = parse('- 写周报\n');
    const id = flatten(doc)[0].node.id;
    expect(applyOp(doc, { op: 'assignBlockId', id, blockId: 'k3f9a2' }).changed).toBe(true);
    expect(serializeOutline(doc)).toBe('- 写周报 ^k3f9a2\n');
  });

  it('文档内已存在同名 blockId → no-op', () => {
    const doc = parse('- a ^k1\n- b\n');
    const b = flatten(doc)[1].node;
    expect(applyOp(doc, { op: 'assignBlockId', id: b.id, blockId: 'k1' }).changed).toBe(false);
    expect(serializeOutline(doc)).toBe('- a ^k1\n- b\n');
  });

  it('重复赋同一个值 → no-op（不触发无谓的文件写入）', () => {
    const doc = parse('- a ^k1\n');
    const id = flatten(doc)[0].node.id;
    expect(applyOp(doc, { op: 'assignBlockId', id, blockId: 'k1' }).changed).toBe(false);
  });
});
