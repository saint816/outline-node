// fast-check property test（见 docs/09）：
//  1. 随机合法树 → serialize → parse → 结构等价
//  2. 随机文本 → parse → serialize 字节相等（raw 通道），且再次往返稳定
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { nanoid } from 'nanoid';
import { parseOutline } from '../../src/core/parser.js';
import { serializeOutline } from '../../src/core/serializer.js';
import type { OutlineDoc, OutlineNode } from '../../src/core/model.js';
import { PARSE_OPTS, shapeOf } from './helpers.js';

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
  return {
    id: nanoid(),
    text: gen.text,
    checked: gen.checked,
    note: gen.note,
    blockId: gen.blockId,
    mirror: null,
    children: gen.children.map(toNode),
    raw: null,
  };
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
