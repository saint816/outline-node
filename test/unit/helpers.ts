import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Block, IndentUnit, OutlineDoc, OutlineNode } from '../../src/core/model.js';

const FIXTURE_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

export const DEFAULT_INDENT: IndentUnit = { kind: 'space', width: 2 };
export const PARSE_OPTS = { defaultIndent: DEFAULT_INDENT };

export interface Fixture {
  name: string;
  text: string;
}

export function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(FIXTURE_DIR, name), 'utf8') }));
}

export function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

// ---------- 结构等价（忽略 id 与 raw） ----------

interface NodeShape {
  text: string;
  checked: boolean | null;
  note: string | null;
  blockId: string | null;
  mirror: string | null;
  children: NodeShape[];
}

type BlockShape = { kind: 'raw'; lines: string[] } | { kind: 'list'; roots: NodeShape[] };

export interface DocShape {
  indentUnit: IndentUnit;
  eol: string;
  eofNewline: boolean;
  blocks: BlockShape[];
}

export function shapeOf(doc: OutlineDoc): DocShape {
  return {
    indentUnit: doc.indentUnit,
    eol: doc.eol,
    eofNewline: doc.eofNewline,
    blocks: doc.blocks.map(shapeBlock),
  };
}

function shapeBlock(block: Block): BlockShape {
  return block.kind === 'raw'
    ? { kind: 'raw', lines: block.lines }
    : { kind: 'list', roots: block.roots.map(shapeNode) };
}

function shapeNode(node: OutlineNode): NodeShape {
  return {
    text: node.text,
    checked: node.checked,
    note: node.note,
    blockId: node.blockId,
    mirror: node.mirror,
    children: node.children.map(shapeNode),
  };
}

/** 文档先序展开所有节点，便于断言。 */
export function flatten(doc: OutlineDoc): { node: OutlineNode; depth: number }[] {
  const out: { node: OutlineNode; depth: number }[] = [];
  const walk = (nodes: OutlineNode[], depth: number): void => {
    for (const node of nodes) {
      out.push({ node, depth });
      walk(node.children, depth + 1);
    }
  };
  for (const block of doc.blocks) if (block.kind === 'list') walk(block.roots, 0);
  return out;
}
