// 行级 markdown 大纲解析器（规格见 docs/03-parser-serializer.md）。
// 禁止引入 remark/mdast/unified：本项目红线是「未编辑内容字节原样」，通用 markdown
// AST 无法保证字节级序列化稳定。

import { nanoid } from 'nanoid';
import {
  BLANK_RE,
  FENCE_RE,
  LIST_ITEM_RE,
  detectIndent,
  indentWidth,
  isFenceClose,
  parseOrderedMarker,
} from './indent.js';
import type { Block, IndentUnit, ListBlock, OutlineDoc, OutlineNode } from './model.js';

const CHECKBOX_RE = /^\[( |x|X)\] /;
const BLOCK_ID_RE = / \^([A-Za-z0-9-]+)$/;
const MIRROR_RE = /^!\[\[#\^([A-Za-z0-9-]+)\]\]$/;

/** 正文恰为 `![[#^id]]` 时返回目标 blockId，否则 null（见 docs/06）。 */
export function parseMirrorTarget(text: string): string | null {
  const m = MIRROR_RE.exec(text);
  return m ? m[1] : null;
}

interface StackEntry {
  width: number;
  node: OutlineNode;
}

interface ListContext {
  roots: OutlineNode[];
  stack: StackEntry[];
  /** 最近一个列表项（note 续行归属对象） */
  lastNode: OutlineNode | null;
  /** 最近一个列表项的内容列（缩进宽度 + bullet 长度 + 1） */
  lastContentCol: number;
  /** 最近一个列表项已收集的 note 行（已剥离缩进） */
  noteLines: string[];
  /** 第一条 note 行的缩进串，用于统一剥离，保留 note 内部相对缩进 */
  noteBaseIndent: string | null;
  /** note 内未闭合围栏的围栏串（null = 不在围栏内）；空行是否终止 note 由它决定 */
  noteFence: string | null;
}

export function parseOutline(text: string, opts: { defaultIndent: IndentUnit }): OutlineDoc {
  const eol = detectEol(text);

  // 空文档：0 字节 → 无 block（见 docs/02 不变式 4）
  if (text === '') {
    return { blocks: [], indentUnit: opts.defaultIndent, eol, eofNewline: false };
  }

  const eofNewline = text.endsWith('\n');
  const lines = text.split(/\r\n|\n/);
  if (eofNewline) lines.pop();

  const indentUnit = detectIndent(lines) ?? opts.defaultIndent;
  const blocks = parseBlocks(lines, indentUnit);

  return { blocks, indentUnit, eol, eofNewline };
}

function detectEol(text: string): '\n' | '\r\n' {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\n') continue;
    if (i > 0 && text[i - 1] === '\r') crlf++;
    else lf++;
  }
  return crlf > lf ? '\r\n' : '\n';
}

function parseBlocks(lines: string[], unit: IndentUnit): Block[] {
  const blocks: Block[] = [];
  let rawLines: string[] | null = null;
  let list: ListContext | null = null;
  let fence: string | null = null;

  const flushRaw = (): void => {
    if (rawLines !== null) {
      blocks.push({ kind: 'raw', id: nanoid(), lines: rawLines });
      rawLines = null;
    }
  };
  const flushList = (): void => {
    if (list !== null) {
      if (list.roots.length > 0) {
        const block: ListBlock = { kind: 'list', id: nanoid(), roots: list.roots };
        blocks.push(block);
      }
      list = null;
    }
  };
  const pushRaw = (line: string): void => {
    flushList();
    if (rawLines === null) rawLines = [];
    rawLines.push(line);
  };

  let i = 0;

  // frontmatter：仅当第 0 行恰为 '---'，收集至下一个恰为 '---' 的行（含）
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1);
    if (close !== -1) {
      blocks.push({ kind: 'raw', id: nanoid(), lines: lines.slice(0, close + 1) });
      i = close + 1;
    }
  }

  for (; i < lines.length; i++) {
    const line = lines[i];

    if (fence !== null) {
      pushRaw(line);
      if (isFenceClose(line, fence)) {
        fence = null;
        // 围栏代码块单独成一个 RawBlock，渲染层才好把它当代码块处理（字节仍原样保留）
        flushRaw();
      }
      continue;
    }

    // 1. note 续行（优先级高于 fence：note 里写 ``` 不进入 fence 状态）
    if (list !== null && list.lastNode !== null && tryAppendNote(list, line, unit)) continue;

    // 2. fence 开启行
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      fence = fenceMatch[1];
      // 先收掉前面累积的 raw，让代码块独占一个 RawBlock
      flushRaw();
      pushRaw(line);
      continue;
    }

    // 3. 列表项行
    const item = LIST_ITEM_RE.exec(line);
    if (item) {
      flushRaw();
      if (list === null) {
        list = {
          roots: [],
          stack: [],
          lastNode: null,
          lastContentCol: 0,
          noteLines: [],
          noteBaseIndent: null,
          noteFence: null,
        };
      }
      appendListItem(list, line, item, unit);
      continue;
    }

    // 4. 空行 / 5. 其他一切（标题、正文、表格、引用块…）
    pushRaw(line);
  }

  flushRaw();
  flushList();
  return blocks;
}

/**
 * note 续行判定：非空、有前导空白、宽度 ≥ 所属列表项的内容列、且本身不是列表项。
 *
 * 例外——**note 里处于未闭合围栏内时，空行也是续行**：代码正文里空行极常见，若按
 * 普通空行终止 note，`- 节点` + 缩进围栏代码块会在重新解析时从空行处截断，模型被拆成
 * 两半（文件字节不丢，但 UI 上代码块断开）。不缩进的行仍然照旧终止，未闭合围栏因此
 * 不会吞掉后面的标题/正文（见 docs/03）。
 */
function tryAppendNote(list: ListContext, line: string, unit: IndentUnit): boolean {
  const blank = BLANK_RE.test(line);
  if (blank && list.noteFence === null) return false;
  if (!blank) {
    const indent = leadingWhitespace(line);
    if (indent.length === 0) return false;
    if (LIST_ITEM_RE.test(line)) return false;
    if (indentWidth(indent, unit) < list.lastContentCol) return false;
    if (list.noteBaseIndent === null) list.noteBaseIndent = indent;
  }

  const node = list.lastNode!;
  const base = list.noteBaseIndent ?? '';
  const stripped = line.startsWith(base) ? line.slice(base.length) : line.trimStart();

  // 围栏状态跟着已剥离缩进的行走（与顶层围栏同一套判定）
  if (list.noteFence === null) {
    const open = FENCE_RE.exec(stripped);
    if (open) list.noteFence = open[1];
  } else if (isFenceClose(stripped, list.noteFence)) {
    list.noteFence = null;
  }

  list.noteLines.push(stripped);
  node.note = list.noteLines.join('\n');
  node.raw!.lines.push(line);
  return true;
}

function appendListItem(
  list: ListContext,
  line: string,
  match: RegExpExecArray,
  unit: IndentUnit,
): void {
  const indent = match[1];
  const width = indentWidth(indent, unit);
  const marker = match[2];
  const ordered = parseOrderedMarker(marker);
  let content = match[3];

  let checked: boolean | null = null;
  const checkbox = CHECKBOX_RE.exec(content);
  if (checkbox) {
    checked = checkbox[1] !== ' ';
    content = content.slice(checkbox[0].length);
  }

  let blockId: string | null = null;
  const blockIdMatch = BLOCK_ID_RE.exec(content);
  if (blockIdMatch) {
    blockId = blockIdMatch[1];
    content = content.slice(0, content.length - blockIdMatch[0].length);
  }

  const mirror = parseMirrorTarget(content);

  // 缩进介于两层之间时归入不大于它的最近一层（宽容处理，raw 兜底原文）
  while (list.stack.length > 0 && list.stack[list.stack.length - 1].width >= width) {
    list.stack.pop();
  }
  const depth = list.stack.length;

  const node: OutlineNode = {
    id: nanoid(),
    text: content,
    checked,
    note: null,
    blockId,
    mirror,
    children: [],
    raw: { lines: [line], depth },
  };
  if (ordered) node.ordered = ordered;

  const parent = list.stack[list.stack.length - 1];
  if (parent) parent.node.children.push(node);
  else list.roots.push(node);

  list.stack.push({ width, node });
  list.lastNode = node;
  list.lastContentCol = width + marker.length + 1; // marker 长度 + 其后的空格
  list.noteLines = [];
  list.noteBaseIndent = null;
  list.noteFence = null;
}

function leadingWhitespace(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : '';
}
