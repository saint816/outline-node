// fast-check property test（见 docs/09）：
//  1. 随机合法树 → serialize → parse → 结构等价
//  2. 随机文本 → parse → serialize 字节相等（raw 通道），且再次往返稳定
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { nanoid } from 'nanoid';
import { parseOutline } from '../../src/core/parser.js';
import { serializeOutline } from '../../src/core/serializer.js';
import { applyOp, type Op } from '../../src/core/ops.js';
import type { OutlineDoc, OutlineNode } from '../../src/core/model.js';
import { PARSE_OPTS, flatten, loadFixtures, shapeOf } from './helpers.js';

// 受控字符集：排除已知歧义（`[x] ` 前缀、行尾 ` ^id`、镜像语法 `![[#^id]]`、bullet 前缀）
const SAFE_CHARS = 'abcXYZ019 中文字符'.split('');
const safeChar = fc.constantFrom(...SAFE_CHARS);

const nonEmptyLine = fc
  .array(safeChar, { minLength: 1, maxLength: 12 })
  .map((cs) => cs.join('').trim())
  .filter((s) => s.length > 0);

const maybeEmptyLine = fc
  .array(safeChar, { maxLength: 12 })
  .map((cs) => cs.join('').trim());

interface GenNode {
  text: string;
  checked: boolean | null;
  note: string | null;
  blockId: string | null;
  children: GenNode[];
}

const { genNode } = fc.letrec<{ genNode: GenNode }>((tie) => ({
  genNode: fc.record({
    text: maybeEmptyLine,
    checked: fc.constantFrom<boolean | null>(null, true, false),
    note: fc.option(
      fc.array(nonEmptyLine, { minLength: 1, maxLength: 3 }).map((ls) => ls.join('\n')),
      { nil: null },
    ),
    blockId: fc.option(
      fc.array(fc.constantFrom(...'abcdef0123456789'.split('')), { minLength: 3, maxLength: 6 }).map((cs) => cs.join('')),
      { nil: null },
    ),
    children: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      fc.constant<GenNode[]>([]),
      fc.array(tie('genNode'), { maxLength: 3 }),
    ),
  }),
}));

function toNode(gen: GenNode): OutlineNode {
  const node: OutlineNode = {
    id: nanoid(),
    text: gen.text,
    checked: gen.checked,
    note: gen.note,
    blockId: gen.blockId,
    mirror: null,
    children: gen.children.map(toNode),
    raw: null,
  };
  return node;
}

function toDoc(gens: GenNode[]): OutlineDoc {
  return {
    blocks: [{ kind: 'list', id: nanoid(), roots: gens.map(toNode) }],
    indentUnit: { kind: 'space', width: 2 },
    eol: '\n',
    eofNewline: true,
  };
}

describe('property：随机树 → serialize → parse', () => {
  it('结构等价（text / checked / note / blockId / 层级）', () => {
    fc.assert(
      fc.property(fc.array(genNode, { minLength: 1, maxLength: 4 }), (gens) => {
        const doc = toDoc(gens);
        const reparsed = parseOutline(serializeOutline(doc), PARSE_OPTS);
        expect(shapeOf(reparsed)).toEqual(shapeOf(doc));
      }),
      { numRuns: 300 },
    );
  });
});

const LINE_POOL = [
  '- a',
  '  - b',
  '    - c',
  '   - 三空格',
  '\t- tab 项',
  '- [ ] todo',
  '- [x] done',
  '* 星号',
  '+ 加号',
  '1. 有序一',
  '2. 有序二',
  '10. 从十',
  '3) 圆括号',
  '  1. 缩进有序',
  '- 带 id ^ab12',
  '- ![[#^ab12]]',
  '  note 行',
  '    深 note',
  '',
  '   ',
  '# 标题',
  '正文',
  '> 引用',
  '```',
  '```js',
  '~~~',
  '---',
  '- ',
  '-',
];

const randomDocText = fc
  .array(fc.constantFrom(...LINE_POOL), { maxLength: 24 })
  .chain((lines) =>
    fc.boolean().map((trailing) => (lines.length === 0 ? '' : lines.join('\n') + (trailing ? '\n' : ''))),
  );

// ---------- 随机 op 序列后仍然结构稳定 ----------

type OpDesc =
  | { kind: 'setText'; i: number; text: string }
  | { kind: 'setNote'; i: number; note: string | null }
  | { kind: 'toggleChecked'; i: number }
  | { kind: 'split'; i: number; offset: number }
  | { kind: 'mergeWithPrevious'; i: number }
  | { kind: 'indent'; i: number }
  | { kind: 'outdent'; i: number }
  | { kind: 'moveUp'; i: number }
  | { kind: 'moveDown'; i: number }
  | { kind: 'move'; i: number; p: number; index: number }
  | { kind: 'delete'; i: number }
  | { kind: 'insertSubtree'; p: number; index: number; text: string };

const opDesc: fc.Arbitrary<OpDesc> = fc.oneof(
  fc.record({ kind: fc.constant('setText' as const), i: fc.nat(), text: maybeEmptyLine }),
  fc.record({
    kind: fc.constant('setNote' as const),
    i: fc.nat(),
    note: fc.option(nonEmptyLine, { nil: null }),
  }),
  fc.record({ kind: fc.constant('toggleChecked' as const), i: fc.nat() }),
  fc.record({ kind: fc.constant('split' as const), i: fc.nat(), offset: fc.nat({ max: 8 }) }),
  fc.record({ kind: fc.constant('mergeWithPrevious' as const), i: fc.nat() }),
  fc.record({ kind: fc.constant('indent' as const), i: fc.nat() }),
  fc.record({ kind: fc.constant('outdent' as const), i: fc.nat() }),
  fc.record({ kind: fc.constant('moveUp' as const), i: fc.nat() }),
  fc.record({ kind: fc.constant('moveDown' as const), i: fc.nat() }),
  fc.record({
    kind: fc.constant('move' as const),
    i: fc.nat(),
    p: fc.nat(),
    index: fc.nat({ max: 5 }),
  }),
  fc.record({ kind: fc.constant('delete' as const), i: fc.nat() }),
  fc.record({
    kind: fc.constant('insertSubtree' as const),
    p: fc.nat(),
    index: fc.nat({ max: 5 }),
    text: nonEmptyLine,
  }),
);

/** 只比较节点内容与层级：块的切分方式可能因删空/相邻合并而不同，文本本身不受影响。 */
function nodeShapes(doc: OutlineDoc): unknown[] {
  const out: unknown[] = [];
  const walk = (nodes: OutlineNode[], depth: number): void => {
    for (const n of nodes) {
      out.push([n.text, n.checked, n.note, n.blockId, n.mirror, depth]);
      walk(n.children, depth + 1);
    }
  };
  for (const block of doc.blocks) if (block.kind === 'list') walk(block.roots, 0);
  return out;
}

function toOp(desc: OpDesc, ids: string[], fresh: () => string): Op | null {
  const pick = (n: number): string | null => (ids.length === 0 ? null : ids[n % ids.length]);
  switch (desc.kind) {
    case 'insertSubtree': {
      const parentId = desc.p % 3 === 0 ? null : pick(desc.p);
      return {
        op: 'insertSubtree',
        parentId,
        index: desc.index,
        nodes: [
          {
            id: fresh(),
            text: desc.text,
            checked: null,
            note: null,
            blockId: null,
            mirror: null,
            children: [],
            raw: null,
          },
        ],
      };
    }
    case 'move': {
      const id = pick(desc.i);
      if (id === null) return null;
      return { op: 'move', id, parentId: desc.p % 3 === 0 ? null : pick(desc.p), index: desc.index };
    }
    case 'setText': {
      const id = pick(desc.i);
      return id === null ? null : { op: 'setText', id, text: desc.text };
    }
    case 'setNote': {
      const id = pick(desc.i);
      return id === null ? null : { op: 'setNote', id, note: desc.note };
    }
    case 'split': {
      const id = pick(desc.i);
      return id === null ? null : { op: 'split', id, offset: desc.offset, newId: fresh() };
    }
    default: {
      const id = pick(desc.i);
      return id === null ? null : ({ op: desc.kind, id } as Op);
    }
  }
}

describe('property：随机 op 序列后仍可无损往返', () => {
  const fixtures = loadFixtures().map((f) => f.text);

  it('serialize → parse 后节点内容与层级不变（红线 1 的结构等价那一半）', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...fixtures),
        fc.array(opDesc, { maxLength: 15 }),
        (text, descs) => {
          const doc = parseOutline(text, PARSE_OPTS);
          let counter = 0;
          const fresh = (): string => `gen${counter++}`;
          for (const desc of descs) {
            const ids = flatten(doc).map((e) => e.node.id);
            const op = toOp(desc, ids, fresh);
            if (op) applyOp(doc, op);
          }
          const reparsed = parseOutline(serializeOutline(doc), PARSE_OPTS);
          expect(nodeShapes(reparsed)).toEqual(nodeShapes(doc));
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('property：随机文本 → parse → serialize', () => {
  it('字节级相等（红线 1）', () => {
    fc.assert(
      fc.property(randomDocText, (text) => {
        expect(serializeOutline(parseOutline(text, PARSE_OPTS))).toBe(text);
      }),
      { numRuns: 1000 },
    );
  });

  it('二次往返结构稳定', () => {
    fc.assert(
      fc.property(randomDocText, (text) => {
        const first = parseOutline(text, PARSE_OPTS);
        const second = parseOutline(serializeOutline(first), PARSE_OPTS);
        expect(shapeOf(second)).toEqual(shapeOf(first));
      }),
      { numRuns: 1000 },
    );
  });
});
