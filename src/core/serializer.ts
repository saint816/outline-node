// 序列化（规格见 docs/03-parser-serializer.md）。
// 红线 2「最小 diff」的实现在这里：raw 通道让未编辑节点字节原样输出。

import { indentWidth } from './indent.js';
import { indentString, type IndentUnit, type OutlineDoc, type OutlineNode } from './model.js';

export function serializeOutline(doc: OutlineDoc): string {
  const unitStr = indentString(doc.indentUnit);
  const lines: string[] = [];

  for (const block of doc.blocks) {
    if (block.kind === 'raw') {
      lines.push(...block.lines);
    } else {
      emitNodes(block.roots, 0, null, doc.indentUnit, unitStr, lines);
    }
  }

  const body = lines.join(doc.eol);
  return doc.eofNewline ? body + doc.eol : body;
}

interface Emitted {
  indent: string;
  width: number;
}

/**
 * 输出一组兄弟节点。
 *
 * 每行的缩进必须落在「> 父行缩进宽度、≤ 前一个兄弟行缩进宽度」区间内——这正是 parser
 * 判定同层兄弟的条件（见 03 的栈式建树）。满足则层级可无损还原，否则重新解析出来的
 * 树会变形。
 *
 * SPEC-GAP: docs/03 只写了「raw.depth 相等就照抄原字节，否则按 indentUnit × 深度重新
 * 生成」。对未经编辑的文档这两条足够；但结构 op 会重排节点，缩进不规范的文档（如
 * nonstandard.md 里 6 空格与 3 空格并存）会踩到两类破坏：
 *   1. 照抄的原字节缩进与新邻居不兼容 → 回退到重新生成；
 *   2. 按深度重新生成的缩进可能不比父行深（父行保留了更宽的原始缩进）→ 改为相对父行
 *      实际缩进 + 一级单位；若因此超过前一个兄弟，则直接沿用兄弟的缩进。
 */
function emitNodes(
  nodes: readonly OutlineNode[],
  depth: number,
  parent: Emitted | null,
  unit: IndentUnit,
  unitStr: string,
  out: string[],
): void {
  const parentWidth = parent === null ? -1 : parent.width;
  let prev: Emitted | null = null;

  for (const node of nodes) {
    const rawIndent =
      node.raw !== null && node.raw.depth === depth ? leadingWhitespace(node.raw.lines[0] ?? '') : null;
    const rawWidth = rawIndent === null ? -1 : indentWidth(rawIndent, unit);

    let emitted: Emitted;
    if (rawIndent !== null && rawWidth > parentWidth && (prev === null || rawWidth <= prev.width)) {
      out.push(...node.raw!.lines);
      emitted = { indent: rawIndent, width: rawWidth };
    } else {
      emitted = generateIndent(parent, prev, unit, unitStr);
      out.push(...renderNode(node, emitted.indent, unit, unitStr));
    }

    prev = emitted;
    emitNodes(node.children, depth + 1, emitted, unit, unitStr, out);
  }
}

function generateIndent(
  parent: Emitted | null,
  prev: Emitted | null,
  unit: IndentUnit,
  unitStr: string,
): Emitted {
  const indent = parent === null ? '' : parent.indent + unitStr;
  const width = indentWidth(indent, unit);
  // 超过前一个兄弟会被解析成它的子节点 → 直接沿用兄弟的缩进（必然是合法的）
  if (prev !== null && width > prev.width) return { indent: prev.indent, width: prev.width };
  return { indent, width };
}

function renderNode(node: OutlineNode, indent: string, unit: IndentUnit, unitStr: string): string[] {
  const checkbox = node.checked === true ? '[x] ' : node.checked === false ? '[ ] ' : '';
  const blockId = node.blockId !== null ? ' ^' + node.blockId : '';
  const lines = [indent + '- ' + checkbox + node.text + blockId];

  if (node.note !== null) {
    // note 续行必须落在内容列（缩进 + "- ".length）之后才会被解析回 note；
    // 1 空格缩进单位的文档下 unitStr 不够宽，兜底用两个空格。
    const step = indentWidth(unitStr, unit) >= 2 ? unitStr : '  ';
    const noteIndent = indent + step;
    for (const noteLine of node.note.split('\n')) lines.push(noteIndent + noteLine);
  }
  return lines;
}

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)![0];
}
