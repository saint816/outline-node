// 缩进检测（规格见 docs/03-parser-serializer.md）。
// SPEC-GAP: docs 只钉了 detectIndent 的签名；行级正则与缩进宽度换算是 parser 与
// detectIndent 共用的实现细节，集中放在本文件，避免两处各写一份而漂移。

import type { IndentUnit, OrderedMarker } from './model.js';

/** 列表项行：缩进 + marker（bullet 或有序 `1.` / `1)`）+ 一个空格 + 正文。 */
export const LIST_ITEM_RE = /^([ \t]*)([-*+]|\d{1,9}[.)]) (.*)$/;

/** marker 是有序标记（`1.` / `1)`）时返回 { delim, num }，否则 null（bullet）。 */
export function parseOrderedMarker(marker: string): OrderedMarker | null {
  const m = /^(\d{1,9})([.)])$/.exec(marker);
  return m ? { num: Number(m[1]), delim: m[2] as '.' | ')' } : null;
}

/** fence 开启/关闭行。 */
export const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;

/** 空行（含只有空白的行）。 */
export const BLANK_RE = /^[ \t]*$/;

/**
 * tab 缩进文件里 tab 的视觉宽度。
 * SPEC-GAP: docs/03 只说「tab 单位文件里 tab 计 1 级」。层级归属由缩进宽度的相对
 * 比较决定，与绝对刻度无关；但 note 续行判定用的是「内容列 = 缩进宽度 + 2」这个
 * 绝对量，若 tab 计 1，`\t\tnote` 的宽度 2 会小于 `\t- x` 的内容列 3，正常的
 * note 会被误判成正文。取 4（事实上的 tab stop）后两者都正确。
 */
const TAB_VISUAL_WIDTH = 4;

/** 缩进字符串的宽度（tab 按当前缩进单位折算）。 */
export function indentWidth(indent: string, unit: IndentUnit): number {
  const tabWidth = unit.kind === 'tab' ? TAB_VISUAL_WIDTH : unit.width;
  let width = 0;
  for (const ch of indent) width += ch === '\t' ? tabWidth : 1;
  return width;
}

/**
 * 从文档行中检测缩进单位。
 * - 任一列表行缩进含 tab → { kind: 'tab' }（tab 优先）
 * - 否则取相邻父子列表行缩进差的众数
 * - 无列表或无父子对 → null（调用方回退到配置 outlineNode.defaultIndent）
 */
export function detectIndent(lines: string[]): IndentUnit | null {
  const diffs = new Map<number, number>();
  const stack: number[] = [];
  let fence: string | null = null;
  let inFrontmatter = lines[0] === '---';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (inFrontmatter) {
      if (i > 0 && line === '---') inFrontmatter = false;
      continue;
    }
    if (fence !== null) {
      if (isFenceClose(line, fence)) fence = null;
      continue;
    }

    const m = LIST_ITEM_RE.exec(line);
    if (!m) {
      if (FENCE_RE.test(line)) fence = FENCE_RE.exec(line)![1];
      continue;
    }

    const indent = m[1];
    if (indent.includes('\t')) return { kind: 'tab' };

    const width = indent.length;
    while (stack.length > 0 && stack[stack.length - 1] >= width) stack.pop();
    if (stack.length > 0) {
      const diff = width - stack[stack.length - 1];
      diffs.set(diff, (diffs.get(diff) ?? 0) + 1);
    }
    stack.push(width);
  }

  if (diffs.size === 0) return null;

  let best = 0;
  let bestCount = 0;
  for (const [width, count] of diffs) {
    // 众数；票数相同取较小的缩进宽度（更常见、更保守）
    if (count > bestCount || (count === bestCount && width < best)) {
      best = width;
      bestCount = count;
    }
  }
  return { kind: 'space', width: best };
}

/** fence 关闭行：同类字符、长度不短于开启行。 */
export function isFenceClose(line: string, open: string): boolean {
  const m = FENCE_RE.exec(line);
  if (!m) return false;
  return m[1][0] === open[0] && m[1].length >= open.length;
}
