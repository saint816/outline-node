// 剪贴板（规格见 docs/05）：粘贴多行缩进列表还原层级，复制子树为 markdown。
// 解析与序列化都复用 core，保证与文件格式完全一致。

import type { OutlineNode } from '../core/model.js';
import { parseOutline } from '../core/parser.js';
import { serializeOutline } from '../core/serializer.js';
import type { CaretPos } from './caret.js';
import { saveCaret } from './caret.js';
import type { NodeSelection } from './selection.js';
import type { Store } from './store.js';

export interface ClipboardContext {
  store: Store;
  /** 节点多选：非空时 copy/cut 作用在整个选区上（见 selection.ts）。 */
  selection: NodeSelection;
  setNextCaret(pos: CaretPos): void;
  /** 把图片字节交给 host 写到文档同目录的 name 文件（见 docs/04 saveImage）。 */
  saveImage(name: string, dataBase64: string): void;
}

export function installClipboard(root: HTMLElement, ctx: ClipboardContext): void {
  root.addEventListener('paste', (event) => onPaste(event, ctx));
  root.addEventListener('copy', (event) => onCopy(event, ctx, false));
  root.addEventListener('cut', (event) => onCopy(event, ctx, true));
}

function onPaste(event: ClipboardEvent, ctx: ClipboardContext): void {
  const caret = saveCaret();
  if (!caret) return;

  // 图片：在光标处插入 Obsidian 原生嵌入语法 ![[name]]，并把字节交给 host 写盘（渲染见 Phase 2）
  const image = imageFileFrom(event.clipboardData);
  if (image) {
    event.preventDefault();
    insertPastedImage(image, ctx, caret);
    return;
  }

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

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

/** 剪贴板里的第一张图片（截图/复制的图片文件）。 */
function imageFileFrom(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of data.items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

/**
 * 在光标处插入 ![[name]] 并把字节发给 host 写盘。
 * 刻意不用 execCommand('insertText')——它已废弃，在 VS Code 的 webview 里对
 * contenteditable="plaintext-only" 会静默失败（返回 false 不插入），导致图写了盘但正文
 * 没有引用（真机复现过）。改经 store 直接把嵌入语法插进当前字段，确定性、跨环境一致。
 * 文件名带时间戳+随机串避免碰撞；host 写完回 imageSaved，webview 届时重渲染让图片加载得到。
 */
function insertPastedImage(file: File, ctx: ClipboardContext, caret: CaretPos): void {
  const ext = MIME_EXT[file.type] ?? 'png';
  // 落到 `<文件名>/assets/` 下（host 注入的 data-assets-dir），别把图片撒在笔记同级目录里
  const dir = (document.documentElement.dataset.assetsDir ?? '').replace(/^\/+|\/+$/g, '');
  const fileName = `pasted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const name = dir === '' ? fileName : `${dir}/${fileName}`;
  const embed = `![[${name}]]`;

  const node = ctx.store.findNode(caret.nodeId);
  if (node) {
    if (caret.field === 'note') {
      const base = node.note ?? '';
      const at = Math.min(caret.offset, base.length);
      ctx.setNextCaret({ nodeId: caret.nodeId, field: 'note', offset: at + embed.length });
      ctx.store.dispatch({ op: 'setNote', id: node.id, note: base.slice(0, at) + embed + base.slice(at) });
    } else {
      const at = Math.min(caret.offset, node.text.length);
      ctx.setNextCaret({ nodeId: caret.nodeId, field: 'text', offset: at + embed.length });
      ctx.store.dispatch({ op: 'setText', id: node.id, text: node.text.slice(0, at) + embed + node.text.slice(at) });
    }
  }

  const reader = new FileReader();
  reader.onload = () => {
    const result = typeof reader.result === 'string' ? reader.result : '';
    const comma = result.indexOf(','); // data:<mime>;base64,<payload>
    if (comma >= 0) ctx.saveImage(name, result.slice(comma + 1));
  };
  reader.readAsDataURL(file);
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
  // 多选优先：整段选区序列化成一份 markdown 列表（cut 再整段删除）
  const selected = ctx.selection.nodes();
  if (selected.length > 0) {
    event.preventDefault();
    event.clipboardData?.setData('text/plain', nodesToMarkdown(ctx, selected));
    if (cut) ctx.selection.deleteSelected(ctx.setNextCaret);
    return;
  }

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
  return nodesToMarkdown(ctx, [node]);
}

/** 若干棵子树 → 一份 markdown 列表（多选复制）。 */
function nodesToMarkdown(ctx: ClipboardContext, nodes: OutlineNode[]): string {
  return serializeOutline({
    blocks: [{ kind: 'list', id: 'clipboard', roots: nodes }],
    indentUnit: ctx.store.doc.indentUnit,
    eol: '\n',
    eofNewline: true,
  });
}
