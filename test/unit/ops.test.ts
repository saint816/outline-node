import { describe, expect, it } from 'vitest';
import { applyOp, type Op } from '../../src/core/ops.js';
import { parseOutline } from '../../src/core/parser.js';
import { serializeOutline } from '../../src/core/serializer.js';
import type { OutlineDoc, OutlineNode } from '../../src/core/model.js';
import { PARSE_OPTS, flatten } from './helpers.js';

function parse(text: string): OutlineDoc {
  return parseOutline(text, PARSE_OPTS);
}

function idOf(doc: OutlineDoc, text: string): string {
  const hit = flatten(doc).find((e) => e.node.text === text);
  if (!hit) throw new Error(`no node with text ${JSON.stringify(text)}`);
  return hit.node.id;
}

function nodeOf(doc: OutlineDoc, text: string): OutlineNode {
  const hit = flatten(doc).find((e) => e.node.text === text);
  if (!hit) throw new Error(`no node with text ${JSON.stringify(text)}`);
  return hit.node;
}

/** 解析 → 施加 op → 序列化，断言最终 markdown。 */
function run(text: string, make: (doc: OutlineDoc) => Op | Op[]): { out: string; doc: OutlineDoc; results: boolean[] } {
  const doc = parse(text);
  const ops = make(doc);
  const results = (Array.isArray(ops) ? ops : [ops]).map((op) => applyOp(doc, op).changed);
  return { out: serializeOutline(doc), doc, results };
}

function shape(doc: OutlineDoc): [string, number][] {
  return flatten(doc).map((e) => [e.node.text, e.depth]);
}

describe('setText / setNote / toggleChecked', () => {
  it('setText 改文本并使 raw 失效', () => {
    const { out, doc } = run('- a\n- b\n', (d) => ({ op: 'setText', id: idOf(d, 'a'), text: 'A' }));
    expect(out).toBe('- A\n- b\n');
    expect(nodeOf(doc, 'A').raw).toBeNull();
    expect(nodeOf(doc, 'b').raw).not.toBeNull(); // 未动的节点保留 raw
  });

  it('目标不存在 → no-op（乐观更新竞态兜底）', () => {
    const { out, results } = run('- a\n', () => ({ op: 'setText', id: 'ghost', text: 'x' }));
    expect(results).toEqual([false]);
    expect(out).toBe('- a\n');
  });

  it('文本没变 → no-op，raw 不动（不做顺手规范化）', () => {
    const { out, doc, results } = run('* a\n', (d) => ({ op: 'setText', id: idOf(d, 'a'), text: 'a' }));
    expect(results).toEqual([false]);
    expect(nodeOf(doc, 'a').raw).not.toBeNull();
    expect(out).toBe('* a\n'); // bullet 未被规范化成 -
  });

  it('setNote 新增 / 修改 / 清除', () => {
    expect(run('- a\n', (d) => ({ op: 'setNote', id: idOf(d, 'a'), note: '备注' })).out).toBe(
      '- a\n  备注\n',
    );
    expect(run('- a\n  旧\n', (d) => ({ op: 'setNote', id: idOf(d, 'a'), note: '新\n两行' })).out).toBe(
      '- a\n  新\n  两行\n',
    );
    expect(run('- a\n  旧\n', (d) => ({ op: 'setNote', id: idOf(d, 'a'), note: null })).out).toBe('- a\n');
  });

  it('toggleChecked：null → true → false → true', () => {
    const doc = parse('- a\n');
    const id = idOf(doc, 'a');
    const toggle: Op = { op: 'toggleChecked', id };
    applyOp(doc, toggle);
    expect(serializeOutline(doc)).toBe('- [x] a\n');
    applyOp(doc, toggle);
    expect(serializeOutline(doc)).toBe('- [ ] a\n');
    applyOp(doc, toggle);
    expect(serializeOutline(doc)).toBe('- [x] a\n');
  });

  it('setChecked：普通节点 → 未勾选任务（null → false，斜杠菜单 To-do 用）', () => {
    const doc = parse('- a\n');
    const id = idOf(doc, 'a');
    expect(applyOp(doc, { op: 'setChecked', id, checked: false }).changed).toBe(true);
    expect(serializeOutline(doc)).toBe('- [ ] a\n');
    // 幂等：同值 no-op
    expect(applyOp(doc, { op: 'setChecked', id, checked: false }).changed).toBe(false);
    // 可设回 null（去掉 checkbox）
    expect(applyOp(doc, { op: 'setChecked', id, checked: null }).changed).toBe(true);
    expect(serializeOutline(doc)).toBe('- a\n');
  });
});

describe('split', () => {
  it('行中拆分：children/note/checked/blockId 留在原节点', () => {
    const { out, doc } = run('- [x] helloworld ^k1\n  note\n  - child\n', (d) => ({
      op: 'split',
      id: idOf(d, 'helloworld'),
      offset: 5,
      newId: 'new1',
    }));
    // 子节点仍挂在原节点下，新节点是原节点的下一个兄弟
    expect(out).toBe('- [x] hello ^k1\n  note\n  - child\n- [ ] world\n');
    const created = nodeOf(doc, 'world');
    expect(created.id).toBe('new1');
    expect(created.checked).toBe(false); // 任务节点里回车新建的是未完成任务
    expect(created.note).toBeNull();
    expect(created.blockId).toBeNull();
    expect(created.children).toEqual([]);
  });

  it('普通节点拆分出的新节点 checked 仍为 null', () => {
    const { doc } = run('- ab\n', (d) => ({ op: 'split', id: idOf(d, 'ab'), offset: 1, newId: 'n' }));
    expect(nodeOf(doc, 'b').checked).toBeNull();
  });

  it('offset 0：原节点变空，全文归新节点（等效上方插入空行）', () => {
    expect(run('- ab\n', (d) => ({ op: 'split', id: idOf(d, 'ab'), offset: 0, newId: 'n' })).out).toBe(
      '- \n- ab\n',
    );
  });

  it('offset 越界被 clamp', () => {
    expect(run('- ab\n', (d) => ({ op: 'split', id: idOf(d, 'ab'), offset: 99, newId: 'n' })).out).toBe(
      '- ab\n- \n',
    );
  });

  it('newId 冲突 → no-op', () => {
    const { out, results } = run('- a\n- b\n', (d) => ({
      op: 'split',
      id: idOf(d, 'a'),
      offset: 0,
      newId: idOf(d, 'b'),
    }));
    expect(results).toEqual([false]);
    expect(out).toBe('- a\n- b\n');
  });
});

describe('mergeWithPrevious', () => {
  it('与前一个兄弟合并', () => {
    const { out } = run('- ab\n- cd\n', (d) => ({ op: 'mergeWithPrevious', id: idOf(d, 'cd') }));
    expect(out).toBe('- abcd\n');
  });

  it('前一个节点是父节点时合并到父节点（先序前驱）', () => {
    const { out } = run('- parent\n  - child\n', (d) => ({
      op: 'mergeWithPrevious',
      id: idOf(d, 'child'),
    }));
    expect(out).toBe('- parentchild\n');
  });

  it('前驱是上一棵子树的最后一个后代', () => {
    const { out } = run('- a\n  - deep\n- b\n', (d) => ({ op: 'mergeWithPrevious', id: idOf(d, 'b') }));
    expect(out).toBe('- a\n  - deepb\n');
  });

  it('note 合并：双方都有 → 换行连接；只有本节点有 → 移交', () => {
    expect(
      run('- a\n  na\n- b\n  nb\n', (d) => ({ op: 'mergeWithPrevious', id: idOf(d, 'b') })).out,
    ).toBe('- ab\n  na\n  nb\n');
    expect(run('- a\n- b\n  nb\n', (d) => ({ op: 'mergeWithPrevious', id: idOf(d, 'b') })).out).toBe(
      '- ab\n  nb\n',
    );
  });

  it('目标没有 blockId 时接管本节点的 blockId（不让镜像断链）', () => {
    const { out } = run('- a\n- b ^k1\n', (d) => ({ op: 'mergeWithPrevious', id: idOf(d, 'b') }));
    expect(out).toBe('- ab ^k1\n');
  });

  it('本节点有子节点 → no-op', () => {
    const { out, results } = run('- a\n- b\n  - c\n', (d) => ({
      op: 'mergeWithPrevious',
      id: idOf(d, 'b'),
    }));
    expect(results).toEqual([false]);
    expect(out).toBe('- a\n- b\n  - c\n');
  });

  it('block 第一个节点 → no-op', () => {
    const { results } = run('- a\n- b\n', (d) => ({ op: 'mergeWithPrevious', id: idOf(d, 'a') }));
    expect(results).toEqual([false]);
  });

  it('镜像行不参与合并 → no-op', () => {
    const { results } = run('- a\n- ![[#^k1]]\n', (d) => ({
      op: 'mergeWithPrevious',
      id: idOf(d, '![[#^k1]]'),
    }));
    expect(results).toEqual([false]);
  });
});

describe('indent / outdent', () => {
  it('indent：成为前一个兄弟的最后一个子节点，整棵子树跟随', () => {
    const { out } = run('- a\n  - a1\n- b\n  - b1\n', (d) => ({ op: 'indent', id: idOf(d, 'b') }));
    expect(out).toBe('- a\n  - a1\n  - b\n    - b1\n');
  });

  it('indent：无前一个兄弟 → no-op', () => {
    const { results, out } = run('- a\n  - a1\n', (d) => ({ op: 'indent', id: idOf(d, 'a1') }));
    expect(results).toEqual([false]);
    expect(out).toBe('- a\n  - a1\n');
  });

  it('outdent：成为父节点的下一个兄弟，其后的同级兄弟留在原父之下', () => {
    const { out, doc } = run('- p\n  - x\n  - y\n  - z\n', (d) => ({
      op: 'outdent',
      id: idOf(d, 'y'),
    }));
    expect(out).toBe('- p\n  - x\n  - z\n- y\n');
    expect(shape(doc)).toEqual([
      ['p', 0],
      ['x', 1],
      ['z', 1],
      ['y', 0],
    ]);
  });

  it('outdent：已在 block 根层 → no-op', () => {
    const { results } = run('- a\n', (d) => ({ op: 'outdent', id: idOf(d, 'a') }));
    expect(results).toEqual([false]);
  });
});

describe('moveUp / moveDown / move', () => {
  it('与前/后兄弟交换，子树整体移动', () => {
    expect(run('- a\n- b\n  - b1\n', (d) => ({ op: 'moveDown', id: idOf(d, 'a') })).out).toBe(
      '- b\n  - b1\n- a\n',
    );
    expect(run('- a\n- b\n', (d) => ({ op: 'moveUp', id: idOf(d, 'b') })).out).toBe('- b\n- a\n');
  });

  it('边界 → no-op', () => {
    expect(run('- a\n- b\n', (d) => ({ op: 'moveUp', id: idOf(d, 'a') })).results).toEqual([false]);
    expect(run('- a\n- b\n', (d) => ({ op: 'moveDown', id: idOf(d, 'b') })).results).toEqual([false]);
  });

  it('同深度重排保持 raw：非规范写法字节原样，diff 最小', () => {
    // 深度不变 → raw.depth 仍然匹配 → 两行都按原始字节输出（* bullet 未被规范化）
    expect(run('* a\n- b\n', (d) => ({ op: 'moveUp', id: idOf(d, 'b') })).out).toBe('- b\n* a\n');
  });

  it('move：reparent 到指定位置', () => {
    const { out } = run('- a\n- b\n  - b1\n', (d) => ({
      op: 'move',
      id: idOf(d, 'a'),
      parentId: idOf(d, 'b'),
      index: 0,
    }));
    expect(out).toBe('- b\n  - a\n  - b1\n');
  });

  it('move：同数组内向后移动，index 按摘除前坐标补偿', () => {
    const { doc } = run('- a\n- b\n- c\n', (d) => ({
      op: 'move',
      id: idOf(d, 'a'),
      parentId: null,
      index: 2,
    }));
    expect(shape(doc)).toEqual([
      ['b', 0],
      ['a', 0],
      ['c', 0],
    ]);
  });

  it('move：成环（目标是自身或后代）→ no-op', () => {
    expect(
      run('- a\n  - a1\n', (d) => ({ op: 'move', id: idOf(d, 'a'), parentId: idOf(d, 'a1'), index: 0 }))
        .results,
    ).toEqual([false]);
    expect(
      run('- a\n', (d) => ({ op: 'move', id: idOf(d, 'a'), parentId: idOf(d, 'a'), index: 0 })).results,
    ).toEqual([false]);
  });

  it('move：跨 ListBlock → no-op（v1 限制）', () => {
    const { results, out } = run('- a\n\n- b\n', (d) => ({
      op: 'move',
      id: idOf(d, 'a'),
      parentId: idOf(d, 'b'),
      index: 0,
    }));
    expect(results).toEqual([false]);
    expect(out).toBe('- a\n\n- b\n');
  });
});

describe('insertSubtree / delete', () => {
  const leaf = (id: string, text: string, children: OutlineNode[] = []): OutlineNode => ({
    id,
    text,
    checked: null,
    note: null,
    blockId: null,
    mirror: null,
    children,
    raw: null,
  });

  it('插入到根层指定位置', () => {
    const { out } = run('- a\n- b\n', () => ({
      op: 'insertSubtree',
      parentId: null,
      index: 1,
      nodes: [leaf('n1', 'x', [leaf('n2', 'x1')])],
    }));
    expect(out).toBe('- a\n- x\n  - x1\n- b\n');
  });

  it('插入到指定父节点下', () => {
    const { out } = run('- a\n', (d) => ({
      op: 'insertSubtree',
      parentId: idOf(d, 'a'),
      index: 0,
      nodes: [leaf('n1', 'child')],
    }));
    expect(out).toBe('- a\n  - child\n');
  });

  it('id 冲突 → 整条拒绝', () => {
    const { out, results } = run('- a\n', (d) => ({
      op: 'insertSubtree',
      parentId: null,
      index: 0,
      nodes: [leaf('fresh', 'x'), leaf(idOf(d, 'a'), 'dup')],
    }));
    expect(results).toEqual([false]);
    expect(out).toBe('- a\n');
  });

  it('空文档：自动新建 ListBlock，让新文件能录入第一个节点', () => {
    const doc = parse('');
    expect(applyOp(doc, { op: 'insertSubtree', parentId: null, index: 0, nodes: [leaf('n1', '第一个')] }).changed).toBe(
      true,
    );
    expect(serializeOutline(doc)).toBe('- 第一个');
  });

  it('delete 删除整棵子树', () => {
    const { out } = run('- a\n  - a1\n- b\n', (d) => ({ op: 'delete', id: idOf(d, 'a') }));
    expect(out).toBe('- b\n');
  });

  it('delete 不存在的 id → no-op', () => {
    expect(run('- a\n', () => ({ op: 'delete', id: 'ghost' })).results).toEqual([false]);
  });
});

describe('raw 失效规则', () => {
  it('改变深度的 op 让整棵被移动子树重生成（无需显式失效传播）', () => {
    // 3 空格缩进文档：b 被 indent 后，b 与其子树按 indentUnit 重生成
    const { out } = run('- a\n- b\n   - b1\n', (d) => ({ op: 'indent', id: idOf(d, 'b') }));
    expect(out).toBe('- a\n   - b\n      - b1\n');
  });

  it('未被 op 触及的节点始终保持 raw 原样', () => {
    const { doc } = run('* a\n* b\n', (d) => ({ op: 'setText', id: idOf(d, 'a'), text: 'A' }));
    expect(nodeOf(doc, 'b').raw).toEqual({ lines: ['* b'], depth: 0 });
  });
});

describe('代码块 op（setRawBlock / toCodeBlock，路线 B）', () => {
  it('setRawBlock 编辑围栏代码块正文，其余字节不动', () => {
    const doc = parse('- a\n```js\nconst x = 1;\n```\n- c\n');
    const code = doc.blocks.find((b) => b.kind === 'raw')!;
    const r = applyOp(doc, { op: 'setRawBlock', id: code.id, lines: ['```js', 'const y = 2;', '```'] });
    expect(r.changed).toBe(true);
    expect(serializeOutline(doc)).toBe('- a\n```js\nconst y = 2;\n```\n- c\n');
  });

  it('setRawBlock 拒绝非围栏 RawBlock（标题不可变，守不变式 2）', () => {
    const doc = parse('# Heading\n');
    const raw = doc.blocks.find((b) => b.kind === 'raw')!;
    const r = applyOp(doc, { op: 'setRawBlock', id: raw.id, lines: ['# Hacked'] });
    expect(r.changed).toBe(false);
    expect(serializeOutline(doc)).toBe('# Heading\n');
  });

  it('setRawBlock 目标不存在 / 内容相同 → no-op', () => {
    const doc = parse('```\ncode\n```\n');
    const code = doc.blocks.find((b) => b.kind === 'raw')!;
    expect(applyOp(doc, { op: 'setRawBlock', id: 'ghost', lines: ['x'] }).changed).toBe(false);
    expect(applyOp(doc, { op: 'setRawBlock', id: code.id, lines: ['```', 'code', '```'] }).changed).toBe(
      false,
    );
  });

  it('toCodeBlock 把中间根节点转成顶层代码块，切开列表', () => {
    const doc = parse('- a\n- b\n- c\n');
    const r = applyOp(doc, {
      op: 'toCodeBlock',
      id: idOf(doc, 'b'),
      lang: 'js',
      blockId: 'CB',
      restId: 'R2',
    });
    expect(r.changed).toBe(true);
    expect(serializeOutline(doc)).toBe('- a\n```js\n\n```\n- c\n');
    // 结构 round-trip 一致
    expect(shapeOfBlocks(parse(serializeOutline(doc)))).toEqual(shapeOfBlocks(doc));
  });

  it('toCodeBlock 首个根节点：before 空，只出代码块 + after 列表', () => {
    const doc = parse('- a\n- b\n');
    applyOp(doc, { op: 'toCodeBlock', id: idOf(doc, 'a'), lang: '', blockId: 'CB', restId: 'R2' });
    expect(serializeOutline(doc)).toBe('```\n\n```\n- b\n');
  });

  it('toCodeBlock 唯一根节点：整段变成一个代码块', () => {
    const doc = parse('- x\n');
    applyOp(doc, { op: 'toCodeBlock', id: idOf(doc, 'x'), lang: 'ts', blockId: 'CB', restId: 'R2' });
    expect(serializeOutline(doc)).toBe('```ts\n\n```\n');
  });

  it('toCodeBlock 拒绝嵌套节点（代码块只能顶层）', () => {
    const doc = parse('- a\n  - b\n');
    const r = applyOp(doc, {
      op: 'toCodeBlock',
      id: idOf(doc, 'b'),
      lang: '',
      blockId: 'CB',
      restId: 'R2',
    });
    expect(r.changed).toBe(false);
    expect(serializeOutline(doc)).toBe('- a\n  - b\n');
  });

  it('toCodeBlock 拒绝有子节点的根（避免丢内容）', () => {
    const doc = parse('- a\n  - a1\n- b\n');
    const r = applyOp(doc, {
      op: 'toCodeBlock',
      id: idOf(doc, 'a'),
      lang: '',
      blockId: 'CB',
      restId: 'R2',
    });
    expect(r.changed).toBe(false);
  });
});

function shapeOfBlocks(doc: OutlineDoc): string[] {
  return doc.blocks.map((b) => (b.kind === 'raw' ? `raw:${b.lines.join('|')}` : `list:${b.roots.length}`));
}
