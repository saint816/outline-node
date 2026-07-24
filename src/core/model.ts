// 数据模型——全项目共享词汇（规格见 docs/02-data-model.md）。
// 本文件零依赖：不得 import vscode，不得使用 DOM API（红线 6）。

// ---------- 文档 ----------
export interface OutlineDoc {
  blocks: Block[];
  indentUnit: IndentUnit; // 检测或配置得到的缩进单位（见 03）
  eol: '\n' | '\r\n'; // 文档主导换行符，序列化时统一使用
  eofNewline: boolean; // 原文件末尾是否有换行，序列化时保持
}

export type IndentUnit =
  | { kind: 'space'; width: number } // 常见 2 或 4；检测结果为准，不 clamp
  | { kind: 'tab' };

// ---------- 块 ----------
export type Block = RawBlock | ListBlock;

export interface RawBlock {
  kind: 'raw';
  id: string; // session 内稳定 id（nanoid），不落盘
  lines: string[]; // 原始行，字节原样（不含行尾符）
}

export interface ListBlock {
  kind: 'list';
  id: string;
  roots: OutlineNode[];
}

// ---------- 节点 ----------
export interface OutlineNode {
  id: string; // session 内稳定 id（nanoid），不落盘；host 在 init/refresh 分配下发
  text: string; // 节点正文（不含 bullet/marker、checkbox、行尾 blockId）
  checked: boolean | null; // null = 普通节点（- text）；false = `- [ ]`；true = `- [x]`
  ordered?: OrderedMarker; // 存在 = 有序列表项（`1.` / `1)`）；不存在 = 普通 bullet（`-`）
  note: string | null; // 节点备注，多行以 '\n' 连接；null = 无备注
  blockId: string | null; // Obsidian block id（行尾 ^abc123 剥离后存这里），见 06
  mirror: string | null; // 非 null 时本节点是镜像行，值为目标 blockId，见 06
  children: OutlineNode[];
  raw: RawSource | null; // 未被编辑时的原始行缓存，保证字节级保真；一经编辑置 null
}

/** 有序列表标记（见 docs/02）。num 为行内字面数字，刻意不自动重排（保最小 diff）。 */
export interface OrderedMarker {
  delim: '.' | ')';
  num: number;
}

export interface RawSource {
  lines: string[]; // 该节点自身的原始行：列表项行 + note 续行（不含子节点的行）
  depth: number; // 解析时所处深度（root = 0）
}

// ---------- 纯函数小工具 ----------
// SPEC-GAP: docs/02 只定义类型，未定义遍历工具；以下均为无状态纯函数，不扩展模型语义。

export function isListBlock(block: Block): block is ListBlock {
  return block.kind === 'list';
}

export function isRawBlock(block: Block): block is RawBlock {
  return block.kind === 'raw';
}

/** 按文档先序遍历所有节点（含所有 ListBlock）。 */
export function forEachNode(
  blocks: readonly Block[],
  visit: (node: OutlineNode, depth: number, parent: OutlineNode | null) => void,
): void {
  for (const block of blocks) {
    if (block.kind !== 'list') continue;
    walk(block.roots, 0, null, visit);
  }
}

function walk(
  nodes: readonly OutlineNode[],
  depth: number,
  parent: OutlineNode | null,
  visit: (node: OutlineNode, depth: number, parent: OutlineNode | null) => void,
): void {
  for (const node of nodes) {
    visit(node, depth, parent);
    walk(node.children, depth + 1, node, visit);
  }
}

/** 缩进单位的字面量（一级缩进对应的字符串）。 */
export function indentString(unit: IndentUnit): string {
  return unit.kind === 'tab' ? '\t' : ' '.repeat(unit.width);
}
