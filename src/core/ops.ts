// 编辑语义的唯一实现（规格见 docs/04-sync-protocol.md）。
// 红线 7：extension host 与 webview 共用这一份 applyOp，禁止任何旁路改树逻辑。

import { nanoid } from 'nanoid';
import { parseMirrorTarget } from './parser.js';
import {
  forEachNode,
  type Block,
  type ListBlock,
  type OutlineDoc,
  type OutlineNode,
  type RawBlock,
} from './model.js';

export type Op =
  | { op: 'setText'; id: string; text: string }
  | { op: 'setNote'; id: string; note: string | null }
  | { op: 'split'; id: string; offset: number; newId: string }
  | { op: 'mergeWithPrevious'; id: string }
  | { op: 'indent'; id: string }
  | { op: 'outdent'; id: string }
  | { op: 'moveUp'; id: string }
  | { op: 'moveDown'; id: string }
  | { op: 'move'; id: string; parentId: string | null; index: number }
  | { op: 'toggleChecked'; id: string }
  | { op: 'setChecked'; id: string; checked: boolean | null }
  | { op: 'toggleOrdered'; id: string }
  | { op: 'insertSubtree'; parentId: string | null; index: number; nodes: OutlineNode[] }
  | { op: 'delete'; id: string }
  | { op: 'assignBlockId'; id: string; blockId: string }
  | { op: 'setRawBlock'; id: string; lines: string[] }
  | { op: 'toCodeBlock'; id: string; lang: string; blockId: string; restId: string }
  | { op: 'deleteRawBlock'; id: string }
  | { op: 'insertRootAfterBlock'; afterBlockId: string; id: string; blockId: string };

export interface OpResult {
  changed: boolean; // false = no-op（如首节点 indent）
}

const NO_OP: OpResult = { changed: false };
const CHANGED: OpResult = { changed: true };

interface Located {
  block: ListBlock;
  node: OutlineNode;
  parent: OutlineNode | null;
  siblings: OutlineNode[];
  index: number;
}

/** 原地修改 doc。 */
export function applyOp(doc: OutlineDoc, op: Op): OpResult {
  switch (op.op) {
    case 'setText':
      return setText(doc, op.id, op.text);
    case 'setNote':
      return setNote(doc, op.id, op.note);
    case 'split':
      return split(doc, op.id, op.offset, op.newId);
    case 'mergeWithPrevious':
      return mergeWithPrevious(doc, op.id);
    case 'indent':
      return indent(doc, op.id);
    case 'outdent':
      return outdent(doc, op.id);
    case 'moveUp':
      return moveBySibling(doc, op.id, -1);
    case 'moveDown':
      return moveBySibling(doc, op.id, 1);
    case 'move':
      return move(doc, op.id, op.parentId, op.index);
    case 'toggleChecked':
      return toggleChecked(doc, op.id);
    case 'setChecked':
      return setChecked(doc, op.id, op.checked);
    case 'toggleOrdered':
      return toggleOrdered(doc, op.id);
    case 'insertSubtree':
      return insertSubtree(doc, op.parentId, op.index, op.nodes);
    case 'delete':
      return remove(doc, op.id);
    case 'assignBlockId':
      return assignBlockId(doc, op.id, op.blockId);
    case 'setRawBlock':
      return setRawBlock(doc, op.id, op.lines);
    case 'toCodeBlock':
      return toCodeBlock(doc, op.id, op.lang, op.blockId, op.restId);
    case 'deleteRawBlock':
      return deleteRawBlock(doc, op.id);
    case 'insertRootAfterBlock':
      return insertRootAfterBlock(doc, op.afterBlockId, op.id, op.blockId);
  }
}

// ---------- 代码块（可编辑的 RawBlock，见 02「代码块：可编辑的 RawBlock」） ----------

const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})/;

/** 编辑围栏代码块：整块替换 lines。唯一能改 RawBlock.lines 的 op（不变式 2 的例外）。 */
function setRawBlock(doc: OutlineDoc, id: string, lines: string[]): OpResult {
  const block = doc.blocks.find((b) => b.id === id);
  if (!block || block.kind !== 'raw') return NO_OP;
  // 只有围栏代码块可编辑；frontmatter / 标题 / 正文 / 图片等其余 RawBlock 严格不可变
  if (block.lines.length === 0 || !FENCE_LINE.test(block.lines[0])) return NO_OP;
  if (block.lines.length === lines.length && block.lines.every((l, i) => l === lines[i])) {
    return NO_OP;
  }
  block.lines = lines;
  return CHANGED;
}

/** 空的顶层根节点 → 顶层代码块（把所在 ListBlock 从该位置切开，中间插入代码块 RawBlock）。 */
function toCodeBlock(
  doc: OutlineDoc,
  id: string,
  lang: string,
  blockId: string,
  restId: string,
): OpResult {
  const found = locate(doc, id);
  if (!found) return NO_OP;
  // 代码块只能在顶层：仅根节点可转，且必须是「空壳」，否则会丢内容
  if (found.parent !== null) return NO_OP;
  if (found.node.children.length > 0 || found.node.note !== null || found.node.mirror !== null) {
    return NO_OP;
  }
  const listIdx = doc.blocks.indexOf(found.block);
  if (listIdx === -1) return NO_OP;
  // 新 block id 不能与现有 block id 冲突（invariant 1）
  const usedBlockIds = new Set(doc.blocks.map((b) => b.id));
  const before = found.block.roots.slice(0, found.index);
  const after = found.block.roots.slice(found.index + 1);
  if (usedBlockIds.has(blockId) || (after.length > 0 && usedBlockIds.has(restId))) return NO_OP;

  const codeBlock: RawBlock = { kind: 'raw', id: blockId, lines: ['```' + lang, '', '```'] };
  const replacement: Block[] = [];
  if (before.length) replacement.push({ kind: 'list', id: found.block.id, roots: before });
  replacement.push(codeBlock);
  if (after.length) replacement.push({ kind: 'list', id: restId, roots: after });
  doc.blocks.splice(listIdx, 1, ...replacement);
  return CHANGED;
}

/** 删除围栏代码块 RawBlock（BUG-004）。删后若前后都是 ListBlock，合并成一个——否则模型里
 * 会留下两个相邻 ListBlock，与「重解析同一文本」得到的单个 ListBlock 不一致。 */
function deleteRawBlock(doc: OutlineDoc, id: string): OpResult {
  const idx = doc.blocks.findIndex((b) => b.id === id);
  if (idx === -1) return NO_OP;
  const block = doc.blocks[idx];
  // 只允许删围栏代码块；frontmatter / 标题 / 正文 / 图片等其余 RawBlock 严格不可删
  if (block.kind !== 'raw' || block.lines.length === 0 || !FENCE_LINE.test(block.lines[0])) {
    return NO_OP;
  }
  doc.blocks.splice(idx, 1);
  const before = doc.blocks[idx - 1];
  const after = doc.blocks[idx];
  if (before?.kind === 'list' && after?.kind === 'list') {
    before.roots.push(...after.roots);
    doc.blocks.splice(idx, 1);
  }
  return CHANGED;
}

/** 在指定块后插入一个空的顶层根节点（BUG-003：末尾代码块后继续录入）。已有后继 ListBlock
 * 则插到它开头，否则新建一个 ListBlock（id = `blockId`，webview 生成、host 采纳）。 */
function insertRootAfterBlock(
  doc: OutlineDoc,
  afterBlockId: string,
  id: string,
  blockId: string,
): OpResult {
  if (locate(doc, id)) return NO_OP; // id 冲突
  const idx = doc.blocks.findIndex((b) => b.id === afterBlockId);
  if (idx === -1) return NO_OP;
  const node: OutlineNode = {
    id,
    text: '',
    checked: null,
    note: null,
    blockId: null,
    mirror: null,
    children: [],
    raw: null,
  };
  const after = doc.blocks[idx + 1];
  if (after?.kind === 'list') {
    after.roots.unshift(node);
  } else {
    if (doc.blocks.some((b) => b.id === blockId)) return NO_OP; // block id 冲突（invariant 1）
    doc.blocks.splice(idx + 1, 0, { kind: 'list', id: blockId, roots: [node] });
  }
  return CHANGED;
}

// ---------- 内容类 op（改字段 → raw 失效） ----------

function setText(doc: OutlineDoc, id: string, text: string): OpResult {
  const found = locate(doc, id);
  if (!found) return NO_OP; // 乐观更新竞态的兜底
  // 文本没变就不动 raw：否则未被真正编辑的行会被"顺手规范化"（红线 2）
  if (found.node.text === text) return NO_OP;
  writeText(found.node, text);
  return CHANGED;
}

function setNote(doc: OutlineDoc, id: string, note: string | null): OpResult {
  const found = locate(doc, id);
  if (!found) return NO_OP;
  if (found.node.note === note) return NO_OP;
  found.node.note = note;
  found.node.raw = null;
  return CHANGED;
}

function toggleChecked(doc: OutlineDoc, id: string): OpResult {
  const found = locate(doc, id);
  if (!found) return NO_OP;
  // null → true、false → true、true → false（决策理由见 docs/02）
  found.node.checked = found.node.checked !== true;
  found.node.raw = null;
  return CHANGED;
}

/** 直接设定完成态（斜杠菜单 To-do 用：toggleChecked 表达不了 null→false 的未勾选任务）。 */
function setChecked(doc: OutlineDoc, id: string, checked: boolean | null): OpResult {
  const found = locate(doc, id);
  if (!found) return NO_OP;
  if (found.node.checked === checked) return NO_OP;
  found.node.checked = checked;
  found.node.raw = null;
  return CHANGED;
}

/** 普通 bullet ↔ 有序项互切。编号：前一个兄弟是有序项则接续，否则从 1 开始。 */
function toggleOrdered(doc: OutlineDoc, id: string): OpResult {
  const found = locate(doc, id);
  if (!found) return NO_OP;
  const node = found.node;
  if (node.ordered) {
    delete node.ordered;
  } else {
    const prev = found.index > 0 ? found.siblings[found.index - 1] : null;
    node.ordered = { delim: '.', num: prev?.ordered ? prev.ordered.num + 1 : 1 };
  }
  node.raw = null; // marker 变了，必须重生成
  return CHANGED;
}

function split(doc: OutlineDoc, id: string, offset: number, newId: string): OpResult {
  const found = locate(doc, id);
  if (!found) return NO_OP;
  // SPEC-GAP: docs/04 只对 insertSubtree 规定了 id 冲突拒绝；split 同样按此兜底
  if (locate(doc, newId)) return NO_OP;

  const { node, siblings, index } = found;
  const at = clamp(offset, 0, node.text.length);
  const tail = node.text.slice(at);
  writeText(node, node.text.slice(0, at));

  // children / note / checked / blockId 全部留在原节点；新节点是裸节点
  const created: OutlineNode = {
    id: newId,
    text: tail,
    checked: node.checked === null ? null : false,
    note: null,
    blockId: null,
    mirror: parseMirrorTarget(tail),
    children: [],
    raw: null,
  };
  // 有序项拆分：新节点接续编号（不重排前面的项，保最小 diff）
  if (node.ordered) created.ordered = { delim: node.ordered.delim, num: node.ordered.num + 1 };
  siblings.splice(index + 1, 0, created);
  return CHANGED;
}

function mergeWithPrevious(doc: OutlineDoc, id: string): OpResult {
  const found = locate(doc, id);
  if (!found) return NO_OP;
  if (found.node.children.length > 0) return NO_OP;

  const order = preorder(found.block);
  const at = order.findIndex((e) => e.node.id === id);
  if (at <= 0) return NO_OP; // block 的第一个节点

  const target = order[at - 1].node;
  const node = found.node;
  if (node.mirror !== null || target.mirror !== null) return NO_OP;

  writeText(target, target.text + node.text);
  if (node.note !== null) {
    target.note = target.note === null ? node.note : target.note + '\n' + node.note;
  }
  // SPEC-GAP: docs 未规定 blockId 的归属。目标没有 blockId 时接管，避免指向本节点的
  // 镜像行因合并而断链；目标已有则丢弃（一行只能有一个 block id）。
  if (target.blockId === null && node.blockId !== null) target.blockId = node.blockId;

  found.siblings.splice(found.index, 1);
  return CHANGED;
}

/**
 * 写入节点正文的唯一入口：同步重算派生字段 mirror，并让 raw 失效。
 * SPEC-GAP: docs/02 把 mirror 定义为「正文恰为 ![[#^id]]」的派生属性，但 docs/04 的
 * op 语义没写改文本时怎么处理它。不重算的话，split/merge 出来的节点会出现
 * 「text 是镜像语法但 mirror 为 null」（或反之）的模型—文件失配。
 */
function writeText(node: OutlineNode, text: string): void {
  node.text = text;
  node.mirror = parseMirrorTarget(text);
  node.raw = null;
}

/** 镜像功能的前置步骤（见 docs/06）：文档内已存在同名 blockId → no-op。 */
function assignBlockId(doc: OutlineDoc, id: string, blockId: string): OpResult {
  const found = locate(doc, id);
  if (!found) return NO_OP;
  if (found.node.blockId === blockId) return NO_OP;

  let duplicate = false;
  forEachNode(doc.blocks, (node) => {
    if (node.blockId === blockId) duplicate = true;
  });
  if (duplicate) return NO_OP;

  found.node.blockId = blockId;
  found.node.raw = null;
  return CHANGED;
}

// ---------- 结构类 op ----------
// 不主动清 raw：深度失配机制（docs/02）会让改变深度的子树自动重生成，
// 同深度的重排则保持字节原样 → diff 最小（红线 2）。

function indent(doc: OutlineDoc, id: string): OpResult {
  const found = locate(doc, id);
  if (!found || found.index === 0) return NO_OP; // 无前一个兄弟
  const prev = found.siblings[found.index - 1];
  found.siblings.splice(found.index, 1);
  prev.children.push(found.node);
  return CHANGED;
}

function outdent(doc: OutlineDoc, id: string): OpResult {
  const found = locate(doc, id);
  if (!found || found.parent === null) return NO_OP; // 已在 block 根层

  const grand = locate(doc, found.parent.id);
  if (!grand) return NO_OP;

  // 原来位于它之后的同级兄弟保持在原父之下
  found.siblings.splice(found.index, 1);
  grand.siblings.splice(grand.index + 1, 0, found.node);
  return CHANGED;
}

function moveBySibling(doc: OutlineDoc, id: string, delta: -1 | 1): OpResult {
  const found = locate(doc, id);
  if (!found) return NO_OP;
  const to = found.index + delta;
  if (to < 0 || to >= found.siblings.length) return NO_OP;
  const [node] = found.siblings.splice(found.index, 1);
  found.siblings.splice(to, 0, node);
  return CHANGED;
}

function move(doc: OutlineDoc, id: string, parentId: string | null, index: number): OpResult {
  const found = locate(doc, id);
  if (!found) return NO_OP;
  if (parentId === id) return NO_OP;

  let targetSiblings: OutlineNode[];
  if (parentId === null) {
    targetSiblings = found.block.roots;
  } else {
    const parent = locate(doc, parentId);
    if (!parent) return NO_OP;
    if (parent.block !== found.block) return NO_OP; // v1：拖拽限制在同一 ListBlock 内
    if (contains(found.node, parentId)) return NO_OP; // 成环
    targetSiblings = parent.node.children;
  }

  // SPEC-GAP: docs 未规定 index 是「摘除前」还是「摘除后」的坐标。取摘除前（拖拽 UI
  // 看到的就是含自身的列表），同数组内向后移动时补偿 -1。
  let at = clamp(index, 0, targetSiblings.length);
  found.siblings.splice(found.index, 1);
  if (targetSiblings === found.siblings && found.index < at) at--;
  at = clamp(at, 0, targetSiblings.length);
  targetSiblings.splice(at, 0, found.node);
  return CHANGED;
}

function insertSubtree(
  doc: OutlineDoc,
  parentId: string | null,
  index: number,
  nodes: OutlineNode[],
): OpResult {
  if (nodes.length === 0) return NO_OP;

  // id 冲突（已存在）→ no-op 整条拒绝
  const incoming = new Set<string>();
  for (const node of nodes) {
    for (const each of subtreeOf(node)) {
      if (locate(doc, each.id) || incoming.has(each.id)) return NO_OP;
      incoming.add(each.id);
    }
  }

  let siblings: OutlineNode[];
  if (parentId === null) {
    // SPEC-GAP: 空文档（或纯 RawBlock 文档）没有 ListBlock 可插入。此时新建一个
    // ListBlock 追加到末尾，否则新文件根本无法录入第一个节点。
    const block = firstListBlock(doc) ?? appendListBlock(doc);
    siblings = block.roots;
  } else {
    const parent = locate(doc, parentId);
    if (!parent) return NO_OP;
    siblings = parent.node.children;
  }

  siblings.splice(clamp(index, 0, siblings.length), 0, ...nodes);
  return CHANGED;
}

function remove(doc: OutlineDoc, id: string): OpResult {
  const found = locate(doc, id);
  if (!found) return NO_OP;
  found.siblings.splice(found.index, 1);
  // SPEC-GAP: 删空的 ListBlock 必须从文档移除。否则模型里留着一个序列化为零行的
  // 幽灵 block，与「重新解析同一文本」得到的结构对不上。
  if (found.block.roots.length === 0) {
    const at = doc.blocks.indexOf(found.block);
    if (at !== -1) doc.blocks.splice(at, 1);
  }
  return CHANGED;
}

// ---------- 工具 ----------

export function locate(doc: OutlineDoc, id: string): Located | null {
  for (const block of doc.blocks) {
    if (block.kind !== 'list') continue;
    const found = locateIn(block, block.roots, null, id);
    if (found) return found;
  }
  return null;
}

function locateIn(
  block: ListBlock,
  siblings: OutlineNode[],
  parent: OutlineNode | null,
  id: string,
): Located | null {
  for (let index = 0; index < siblings.length; index++) {
    const node = siblings[index];
    if (node.id === id) return { block, node, parent, siblings, index };
    const found = locateIn(block, node.children, node, id);
    if (found) return found;
  }
  return null;
}

/** ListBlock 内的文档先序。 */
function preorder(block: ListBlock): { node: OutlineNode }[] {
  const out: { node: OutlineNode }[] = [];
  const walk = (nodes: OutlineNode[]): void => {
    for (const node of nodes) {
      out.push({ node });
      walk(node.children);
    }
  };
  walk(block.roots);
  return out;
}

function subtreeOf(node: OutlineNode): OutlineNode[] {
  const out: OutlineNode[] = [];
  const walk = (n: OutlineNode): void => {
    out.push(n);
    for (const child of n.children) walk(child);
  };
  walk(node);
  return out;
}

/** node 的子树（含自身）里是否存在 id。 */
function contains(node: OutlineNode, id: string): boolean {
  return subtreeOf(node).some((n) => n.id === id);
}

function firstListBlock(doc: OutlineDoc): ListBlock | null {
  for (const block of doc.blocks) if (block.kind === 'list') return block;
  return null;
}

function appendListBlock(doc: OutlineDoc): ListBlock {
  const block: ListBlock = { kind: 'list', id: nanoid(), roots: [] };
  doc.blocks.push(block);
  return block;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
