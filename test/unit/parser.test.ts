import { describe, expect, it } from 'vitest';
import { parseOutline } from '../../src/core/parser.js';
import type { ListBlock, RawBlock } from '../../src/core/model.js';
import { PARSE_OPTS, flatten, loadFixture } from './helpers.js';

function listBlock(doc: ReturnType<typeof parseOutline>, index: number): ListBlock {
  const block = doc.blocks[index];
  if (block.kind !== 'list') throw new Error(`block ${index} is not a list block`);
  return block;
}

function rawBlock(doc: ReturnType<typeof parseOutline>, index: number): RawBlock {
  const block = doc.blocks[index];
  if (block.kind !== 'raw') throw new Error(`block ${index} is not a raw block`);
  return block;
}

describe('parseOutline — 层级', () => {
  it('basic.md：2 空格缩进的多层嵌套', () => {
    const doc = parseOutline(loadFixture('basic.md'), PARSE_OPTS);
    expect(doc.indentUnit).toEqual({ kind: 'space', width: 2 });
    expect(doc.blocks).toHaveLength(1);
    expect(listBlock(doc, 0).roots.map((n) => n.text)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(flatten(doc).map((e) => [e.node.text, e.depth])).toEqual([
      ['Alpha', 0],
      ['Alpha one', 1],
      ['Alpha one deep', 2],
      ['Alpha two', 1],
      ['Beta', 0],
      ['Gamma', 0],
      ['Gamma one', 1],
      ['Gamma one deep', 2],
      ['Gamma one deeper', 3],
    ]);
  });

  it('nonstandard.md：3 空格缩进、*/+ bullet、层级跳跃归入不大于它的最近一层', () => {
    const doc = parseOutline(loadFixture('nonstandard.md'), PARSE_OPTS);
    expect(doc.indentUnit).toEqual({ kind: 'space', width: 3 });
    expect(flatten(doc).map((e) => [e.node.text, e.depth])).toEqual([
      ['三空格缩进', 0],
      ['第二层', 1],
      ['第三层', 2],
      ['星号 bullet', 0],
      ['加号 bullet', 1],
      ['层级跳跃', 0],
      ['直接跳两级', 1],
      ['回到第二层', 1],
    ]);
  });
});

describe('parseOutline — 行内剥离', () => {
  it('checkbox 三态（logseq-tabs.md，tab 缩进）', () => {
    const doc = parseOutline(loadFixture('logseq-tabs.md'), PARSE_OPTS);
    expect(doc.indentUnit).toEqual({ kind: 'tab' });
    expect(flatten(doc).map((e) => [e.node.text, e.node.checked, e.depth])).toEqual([
      ['Today', null, 0],
      ['写周报', false, 1],
      ['站会', true, 1],
      ['记录纪要', false, 2],
      ['Someday', null, 0],
      ['学 Rust', null, 1],
      ['读 TAOCP', false, 1],
    ]);
  });

  it('blockId 剥离到 blockId 字段，text 中不含', () => {
    const doc = parseOutline(loadFixture('obsidian-vault.md'), PARSE_OPTS);
    const nodes = flatten(doc).map((e) => e.node);
    expect(nodes[0].text).toBe('任务清单');
    expect(nodes[0].blockId).toBe('plan1');
    expect(nodes.find((n) => n.blockId === 'ref9')?.text).toBe('Workflowy');
    expect(nodes[1].blockId).toBeNull();
  });

  it('镜像行：正文恰为 ![[#^id]] 时 mirror = id，text 保留原文', () => {
    const doc = parseOutline(loadFixture('mirrors.md'), PARSE_OPTS);
    const nodes = flatten(doc).map((e) => e.node);
    const mirror = nodes.find((n) => n.mirror !== null)!;
    expect(mirror.mirror).toBe('k3f9a2');
    expect(mirror.text).toBe('![[#^k3f9a2]]');
    expect(nodes.filter((n) => n.mirror !== null).map((n) => n.mirror)).toEqual([
      'k3f9a2',
      'missing',
    ]);
    expect(nodes[0].blockId).toBe('k3f9a2');
  });

  it('大写 [X] 也识别为已完成', () => {
    const doc = parseOutline('- [X] done\n', PARSE_OPTS);
    expect(flatten(doc)[0].node.checked).toBe(true);
  });
});

describe('parseOutline — note 续行', () => {
  it('单行 / 多行 / 含 fence / 后接子列表', () => {
    const doc = parseOutline(loadFixture('notes.md'), PARSE_OPTS);
    const nodes = flatten(doc).map((e) => e.node);
    expect(nodes.map((n) => n.text)).toEqual([
      '带单行 note 的节点',
      '带多行 note 的节点',
      'note 中含 fence',
      'note 后接子列表',
      '子节点一',
      '子节点二',
    ]);
    expect(nodes[0].note).toBe('这是一行备注。');
    expect(nodes[1].note).toBe('第一行备注。\n第二行备注。');
    // note 判定优先于 fence：note 里的 ``` 不进入 fence 状态
    expect(nodes[2].note).toBe('```js\nconst a = 1;\n```');
    expect(nodes[3].note).toBe('这是备注。');
    expect(nodes[4].note).toBe('子节点的备注。');
    expect(nodes[5].note).toBeNull();
  });

  it('缩进小于内容列的续行不算 note，终结 ListBlock', () => {
    const doc = parseOutline('- a\n 续行太浅\n', PARSE_OPTS);
    expect(doc.blocks.map((b) => b.kind)).toEqual(['list', 'raw']);
    expect(rawBlock(doc, 1).lines).toEqual([' 续行太浅']);
  });
});

describe('parseOutline — 块边界', () => {
  it('frontmatter 独立成 RawBlock，列表与正文分块正确', () => {
    const doc = parseOutline(loadFixture('obsidian-vault.md'), PARSE_OPTS);
    expect(doc.blocks.map((b) => b.kind)).toEqual(['raw', 'raw', 'list', 'raw']);
    expect(rawBlock(doc, 0).lines).toEqual([
      '---',
      'title: Vault note',
      'tags: [outline, demo]',
      '---',
    ]);
    expect(listBlock(doc, 2).roots.map((n) => n.text)).toEqual(['任务清单', '参考资料']);
  });

  it('代码块内的 "- " 行不得误判为列表项，且围栏块各自独占 RawBlock', () => {
    const doc = parseOutline(loadFixture('code-fence.md'), PARSE_OPTS);
    // 每个围栏代码块单独成一个 RawBlock（渲染层据此当代码块处理），字节仍原样保留
    expect(doc.blocks.map((b) => b.kind)).toEqual(['raw', 'raw', 'raw', 'list', 'raw', 'raw']);
    expect(rawBlock(doc, 1).lines).toContain('- 这是代码块里的列表');
    expect(listBlock(doc, 3).roots.map((n) => n.text)).toEqual(['真正的列表']);
    expect(rawBlock(doc, 5).lines).toContain('+ 波浪号 fence 内的伪列表');
  });

  it('空行分隔的列表拆成多个 ListBlock，空行进 RawBlock', () => {
    const doc = parseOutline(loadFixture('loose-list.md'), PARSE_OPTS);
    expect(doc.blocks.map((b) => b.kind)).toEqual(['list', 'raw', 'list', 'raw', 'list']);
    expect(rawBlock(doc, 3).lines).toEqual(['', '正文段落。', '']);
  });

  it('CRLF 文档：eol 为 \\r\\n，末尾无换行', () => {
    const doc = parseOutline(loadFixture('crlf.md'), PARSE_OPTS);
    expect(doc.eol).toBe('\r\n');
    expect(doc.eofNewline).toBe(false);
    expect(doc.blocks.map((b) => b.kind)).toEqual(['list', 'raw']);
    expect(flatten(doc).map((e) => e.node.text)).toEqual(['CRLF 一', '子项', '完成项', 'CRLF 二']);
  });

  it('空文档解析为 0 个 block（不变式 4）', () => {
    const doc = parseOutline(loadFixture('empty.md'), PARSE_OPTS);
    expect(doc.blocks).toEqual([]);
    expect(doc.eofNewline).toBe(false);
    expect(doc.indentUnit).toEqual(PARSE_OPTS.defaultIndent);
  });

  it('只含空行的文档：单个 RawBlock，无 ListBlock（不变式 5）', () => {
    const doc = parseOutline(loadFixture('blank-lines.md'), PARSE_OPTS);
    expect(doc.blocks.map((b) => b.kind)).toEqual(['raw']);
    expect(rawBlock(doc, 0).lines).toEqual(['', '', '']);
  });

  it('未闭合的 --- 不当作 frontmatter', () => {
    const doc = parseOutline('---\n- a\n', PARSE_OPTS);
    expect(doc.blocks.map((b) => b.kind)).toEqual(['raw', 'list']);
    expect(rawBlock(doc, 0).lines).toEqual(['---']);
  });
});

describe('parseOutline — raw 保真通道', () => {
  it('每个节点的 raw 记录自身原始行（含 note 行）与解析深度', () => {
    const doc = parseOutline('- a\n  note\n  - b\n', PARSE_OPTS);
    const [a, b] = flatten(doc).map((e) => e.node);
    expect(a.raw).toEqual({ lines: ['- a', '  note'], depth: 0 });
    expect(b.raw).toEqual({ lines: ['  - b'], depth: 1 });
  });
});
