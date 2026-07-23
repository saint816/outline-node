// 剪贴板（规格见 docs/05）：粘贴多行缩进列表还原层级，复制子树为 markdown。
// 解析与序列化都复用 core，保证与文件格式完全一致。

import type { OutlineNode } from '../core/model.js';
import { parseOutline } from '../core/parser.js';
import { serializeOutline } from '../core/serializer.js';
import type { CaretPos } from './caret.js';
import { saveCaret } from './caret.js';
import type { Store } from './store.js';

export interface ClipboardContext {
  store: Store;
  setNextCaret(pos: CaretPos): void;
}

export function installClipboard(root: HTMLElement, ctx: ClipboardContext): void {
  root.addEventListener('paste', (event) => onPaste(event, ctx));
  root.addEventListener('copy', (event) => onCopy(event, ctx, false));
  root.addEventListener('cut', (event) => onCopy(event, ctx, true));
}

function onPaste(event: ClipboardEvent, ctx: ClipboardContext): void {
  const caret = saveCaret();
  if (!caret) return;
  const text = event.clipboardData?.getData('text/plain') ?? '';

  // SPEC-GAP: docs/05 说 paste 一律 preventDefault 后自己插入。单行文本没必要——
  // contenteditable="plaintext-only" 本身就杜绝了富文本，交给浏览器插入反而不会碰光标。
  // 只接管「多行」这一种浏览器会把节点写成多行的情况；note 字段本就是多行，也放过。
  if (caret.field === 'note' || !text.includes('\n')) return;

  event.preventDefault();
  const nodes = parseClipboardNodes(text, ctx);
  if (nodes.length === 0) return;

  const location = ctx.store.locationOf(caret.nodeId);
  if (!location) return;
  const current = ctx.store.findNode(caret.nodeId);

  const last = lastNode(nodes[nodes.length - 1]);
  ctx.setNextCaret({ nodeId: last.id, field: 'text', offset: last.text.length });
  ctx.store.dispatch({
    op: 'insertSubtree',
    parentId: location.parentId,
    index: location.index + 1,
    nodes,
  });

  // 在空节点上粘贴：把那个空壳收掉，符合直觉
  if (current && current.text === '' && current.note === null && current.children.length === 0) {
    ctx.store.dispatch({ op: 'delete', id: caret.nodeId });
  }
}

/** 剪贴板文本 → 子树。含列表语法就按缩进还原层级，否则按行拆成兄弟节点。 */
function parseClipboardNodes(text: string, ctx: ClipboardContext): OutlineNode[] {
  const indentUnit = ctx.store.doc.indentUnit;
  const doc = parseOutline(text, { defaultIndent: indentUnit });
  const listBlock = doc.blocks.find((block) => block.kind === 'list');
  if (listBlock && listBlock.kind === 'list' && listBlock.roots.length > 0) {
    return listBlock.roots.map(stripRaw);
  }

  return text
    .split(/\r\n|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => bareNode(line, doc.blocks[0]?.id ?? ''));
}

function bareNode(text: string, seed: string): OutlineNode {
  return {
    id: seed + ':' + Math.random().toString(36).slice(2, 10),
    text,
    checked: null,
    note: null,
    blockId: null,
    mirror: null,
    children: [],
    raw: null,
  };
}

/** 快照约定 raw 为 null（见 docs/02）。 */
function stripRaw(node: OutlineNode): OutlineNode {
  return { ...node, raw: null, children: node.children.map(stripRaw) };
}

function lastNode(node: OutlineNode): OutlineNode {
  return node.children.length === 0 ? node : lastNode(node.children[node.children.length - 1]);
}

function onCopy(event: ClipboardEvent, ctx: ClipboardContext, cut: boolean): void {
  const selection = window.getSelection();
  // 选中了文本 → 走浏览器默认的文本复制
  if (selection && !selection.isCollapsed) return;

  const caret = saveCaret();
  if (!caret || caret.field !== 'text') return;
  const node = ctx.store.findNode(caret.nodeId);
  if (!node) return;

  event.preventDefault();
  event.clipboardData?.setData('text/plain', subtreeToMarkdown(ctx, node));

  if (!cut) return;
  const previous = ctx.store.previousNode(node.id);
  if (previous) ctx.setNextCaret({ nodeId: previous.id, field: 'text', offset: previous.text.length });
  ctx.store.dispatch({ op: 'delete', id: node.id });
}

/** 光标所在节点的整棵子树 → markdown 列表（与文件里的写法一致）。 */
export function subtreeToMarkdown(ctx: ClipboardContext, node: OutlineNode): string {
  return serializeOutline({
    blocks: [{ kind: 'list', id: 'clipboard', roots: [node] }],
    indentUnit: ctx.store.doc.indentUnit,
    eol: '\n',
    eofNewline: true,
  });
}
