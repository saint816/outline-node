// 红线 1：round-trip 幂等。所有 fixture 必须过。
import { describe, expect, it } from 'vitest';
import { parseOutline } from '../../src/core/parser.js';
import { serializeOutline } from '../../src/core/serializer.js';
import { forEachNode } from '../../src/core/model.js';
import { PARSE_OPTS, loadFixtures, shapeOf } from './helpers.js';

const fixtures = loadFixtures();

describe('round-trip', () => {
  it('fixture 清单齐全（见 docs/03）', () => {
    expect(fixtures.map((f) => f.name)).toEqual([
      'basic.md',
      'blank-lines.md',
      'code-fence.md',
      'crlf.md',
      'empty.md',
      'logseq-tabs.md',
      'loose-list.md',
      'mirrors.md',
      'nonstandard.md',
      'notes.md',
      'obsidian-vault.md',
    ]);
  });

  for (const { name, text } of fixtures) {
    it(`${name}: serialize(parse(s)) 字节级等于 s`, () => {
      expect(serializeOutline(parseOutline(text, PARSE_OPTS))).toBe(text);
    });

    it(`${name}: parse(serialize(parse(s))) 与 parse(s) 结构等价`, () => {
      const first = parseOutline(text, PARSE_OPTS);
      const second = parseOutline(serializeOutline(first), PARSE_OPTS);
      expect(shapeOf(second)).toEqual(shapeOf(first));
    });

    it(`${name}: id 全局唯一（不变式 1）`, () => {
      const doc = parseOutline(text, PARSE_OPTS);
      const ids = new Set<string>();
      for (const block of doc.blocks) {
        expect(ids.has(block.id)).toBe(false);
        ids.add(block.id);
      }
      forEachNode(doc.blocks, (node) => {
        expect(ids.has(node.id)).toBe(false);
        ids.add(node.id);
      });
    });
  }
});

describe('已知取舍（模型层面的规格决策，非 bug）', () => {
  it('混合换行符按主导 eol 归一——docs/02 规定 OutlineDoc 只有一个 eol 字段', () => {
    const mixed = '- a\r\n- b\n- c\r\n';
    // \r\n 占多数 → 统一为 \r\n；单一换行符的文档不受影响（见 crlf.md fixture）
    expect(serializeOutline(parseOutline(mixed, PARSE_OPTS))).toBe('- a\r\n- b\r\n- c\r\n');
  });

  it('用户输入以 "[x] " 开头的文本会在往返后变成 checkbox（docs/02 已接受的 markdown 固有歧义）', () => {
    const doc = parseOutline('- x\n', PARSE_OPTS);
    const block = doc.blocks[0];
    if (block.kind !== 'list') throw new Error('expected list block');
    block.roots[0].text = '[x] 看起来像任务';
    block.roots[0].raw = null;
    const reparsed = parseOutline(serializeOutline(doc), PARSE_OPTS);
    const node = (reparsed.blocks[0] as { roots: { text: string; checked: boolean | null }[] })
      .roots[0];
    expect(node.checked).toBe(true);
    expect(node.text).toBe('看起来像任务');
  });
});

describe('编辑后重生成', () => {
  it('被编辑的节点重生成，未编辑的邻居保持字节原样', () => {
    const text = '- 三空格缩进\n   - 第二层\n';
    const doc = parseOutline(text, PARSE_OPTS);
    const child = doc.blocks[0].kind === 'list' ? doc.blocks[0].roots[0].children[0] : null;
    child!.text = '改过了';
    child!.raw = null;
    // 未编辑的父节点走 raw 原样；被编辑的子节点按检测到的缩进单位（3 空格）重生成
    expect(serializeOutline(doc)).toBe('- 三空格缩进\n   - 改过了\n');
  });

  it('深度失配的节点自动重生成（无需显式失效传播）', () => {
    const text = '- a\n  - b\n    - c\n';
    const doc = parseOutline(text, PARSE_OPTS);
    const block = doc.blocks[0];
    if (block.kind !== 'list') throw new Error('expected list block');
    // 把 b（连同子树 c）提升到根层：raw.depth 失配 → b 与 c 都重生成
    const [a] = block.roots;
    const b = a.children[0];
    a.children = [];
    b.raw = null;
    block.roots.push(b);
    expect(serializeOutline(doc)).toBe('- a\n- b\n  - c\n');
  });
});
