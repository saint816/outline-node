// 序列化（规格见 docs/03-parser-serializer.md）。
// 红线 2「最小 diff」的实现在这里：raw 通道让未编辑节点字节原样输出。

import { indentString, type OutlineDoc, type OutlineNode } from './model.js';

export function serializeOutline(doc: OutlineDoc): string {
  const unit = indentString(doc.indentUnit);
  const lines: string[] = [];

  for (const block of doc.blocks) {
    if (block.kind === 'raw') {
      lines.push(...block.lines);
    } else {
      emitNodes(block.roots, 0, unit, lines);
    }
  }

  const body = lines.join(doc.eol);
  return doc.eofNewline ? body + doc.eol : body;
}

function emitNodes(nodes: readonly OutlineNode[], depth: number, unit: string, out: string[]): void {
  for (const node of nodes) {
    // raw.depth 失配 → 该节点被移动过，走重生成（见 docs/02「深度比较的妙处」）
    if (node.raw !== null && node.raw.depth === depth) {
      out.push(...node.raw.lines);
    } else {
      out.push(...renderNode(node, depth, unit));
    }
    emitNodes(node.children, depth + 1, unit, out);
  }
}

function renderNode(node: OutlineNode, depth: number, unit: string): string[] {
  const indent = unit.repeat(depth);
  const checkbox = node.checked === true ? '[x] ' : node.checked === false ? '[ ] ' : '';
  const blockId = node.blockId !== null ? ' ^' + node.blockId : '';
  const lines = [indent + '- ' + checkbox + node.text + blockId];

  if (node.note !== null) {
    const noteIndent = indent + unit;
    for (const noteLine of node.note.split('\n')) lines.push(noteIndent + noteLine);
  }
  return lines;
}
