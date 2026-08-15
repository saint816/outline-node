// UI 树 + 发送队列（规格见 docs/04「webview 侧：发送队列与防抖」）。
// 本模块不直接操作 DOM，也不直接 postMessage 之外的事；编辑语义一律走 core/ops。

import type { OutlineDoc, OutlineNode } from '../core/model.js';
import { nodeKeys } from '../core/nodeKey.js';
import { applyOp, locate, type Op } from '../core/ops.js';
import { hasMirrors, originalIdOf } from './mirror.js';
import type { DocSnapshot, EditorConfig, H2W, W2H } from '../shared/protocol.js';

export interface VisibleRow {
  node: OutlineNode;
  depth: number;
  parentId: string | null;
  index: number;
  blockId: string;
}

const SET_TEXT_DEBOUNCE_MS = 300;
/** 连续输入超过这个时长强制 flush，限制丢失窗口与 undo 步长。 */
const MAX_PENDING_MS = 1000;
/** 折叠变化上报节流（见 docs/06）。 */
const SAVE_FOLDING_THROTTLE_MS = 2000;

export class Store {
  private current: OutlineDoc = emptyDoc();
  private baseVersion = 0;
  private seq = 0;
  private pending: Op[] = [];
  private inFlight = false;
  private timer: number | null = null;
  private firstPendingAt = 0;
  private readonly listeners: (() => void)[] = [];

  // ---------- UI 状态（折叠 / zoom；红线 3：只在内存与 workspaceState，绝不落用户文件） ----------
  private readonly folded = new Set<string>();
  private zoomRootId: string | null = null;
  private foldingTimer: number | null = null;
  private searchQuery = '';
  private hideCompletedState = false;
  /** 星标书签，存 nodeKey（跨 session 稳定，见 docs/06）；绝不写进用户文件。 */
  private readonly bookmarks = new Set<string>();
  private bookmarksTimer: number | null = null;
  /** 参与镜像（被 ![[#^id]] 引用的子树）的数据 id，随文档变化重算。 */
  private mirroredIds: Set<string> | null = null;

  config: EditorConfig | null = null;

  constructor(private readonly send: (msg: W2H) => void) {}

  get doc(): OutlineDoc {
    return this.current;
  }

  get version(): number {
    return this.baseVersion;
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  /**
   * 镜像视图里的 DOM id 是复合 id（`${mirrorNodeId}/${originalId}`，见 docs/06）。
   * store 的公共入口统一归一到数据层 id——这样「编辑同步零成本」：镜像视图里的编辑
   * 落到同一份数据，下一次 patch 两个视图自然一致。
   */
  findNode(id: string): OutlineNode | null {
    return locate(this.current, originalIdOf(id))?.node ?? null;
  }

  /** 文档先序里的前一个节点（同一 ListBlock 内），用于 Backspace 合并的落点计算。 */
  previousNode(id: string): OutlineNode | null {
    const found = locate(this.current, originalIdOf(id));
    if (!found) return null;
    const order: OutlineNode[] = [];
    const walk = (nodes: OutlineNode[]): void => {
      for (const n of nodes) {
        order.push(n);
        walk(n.children);
      }
    };
    walk(found.block.roots);
    const at = order.findIndex((n) => n.id === originalIdOf(id));
    return at > 0 ? order[at - 1] : null;
  }

  // ---------- 折叠 ----------

  get foldedIds(): ReadonlySet<string> {
    return this.folded;
  }

  isFolded(id: string): boolean {
    return this.folded.has(originalIdOf(id));
  }

  toggleFold(rawId: string): void {
    const id = originalIdOf(rawId);
    const node = this.findNode(id);
    if (!node || node.children.length === 0) return;
    if (this.folded.has(id)) this.folded.delete(id);
    else this.folded.add(id);
    this.scheduleSaveFolding();
    this.emit();
  }

  /** 折叠态挂在内存 id 上，编辑期间永不丢；落盘时才换算成 nodeKey（见 docs/06）。 */
  flushFolding(): void {
    if (this.foldingTimer !== null) {
      clearTimeout(this.foldingTimer);
      this.foldingTimer = null;
    }
    const keys = nodeKeys(this.current.blocks);
    const foldedKeys: string[] = [];
    for (const id of this.folded) {
      const key = keys.get(id);
      if (key !== undefined) foldedKeys.push(key);
    }
    this.flushPending(); // saveFolding 之前先把待发编辑顶出去（见 docs/04）
    this.send({ type: 'saveFolding', foldedKeys });
  }

  private scheduleSaveFolding(): void {
    if (this.foldingTimer !== null) return;
    this.foldingTimer = setTimeout(() => {
      this.foldingTimer = null;
      this.flushFolding();
    }, SAVE_FOLDING_THROTTLE_MS) as unknown as number;
  }

  /** init 时按 nodeKey 反查节点标记折叠；无记录则按 defaultFold 处理。 */
  private restoreFolding(foldedKeys: string[]): void {
    this.folded.clear();
    if (foldedKeys.length > 0) {
      const wanted = new Set(foldedKeys);
      for (const [id, key] of nodeKeys(this.current.blocks)) {
        if (wanted.has(key)) this.folded.add(id);
      }
      return;
    }
    if (this.config?.defaultFold !== 'firstLevel') return;
    for (const block of this.current.blocks) {
      if (block.kind !== 'list') continue;
      for (const root of block.roots) if (root.children.length > 0) this.folded.add(root.id);
    }
  }

  // ---------- zoom ----------

  get zoomRoot(): string | null {
    return this.zoomRootId;
  }

  zoomTo(rawId: string | null): void {
    const id = rawId === null ? null : originalIdOf(rawId);
    if (id !== null && !this.findNode(id)) return;
    if (this.zoomRootId === id) return;
    this.zoomRootId = id;
    this.emit();
  }

  /** zoom 根的祖先链（含自身），面包屑用。 */
  zoomTrail(): OutlineNode[] {
    if (this.zoomRootId === null) return [];
    const trail: OutlineNode[] = [];
    const walk = (nodes: OutlineNode[], path: OutlineNode[]): boolean => {
      for (const node of nodes) {
        const next = [...path, node];
        if (node.id === this.zoomRootId) {
          trail.push(...next);
          return true;
        }
        if (walk(node.children, next)) return true;
      }
      return false;
    };
    for (const block of this.current.blocks) {
      if (block.kind === 'list' && walk(block.roots, [])) break;
    }
    return trail;
  }

  /** 当前可见（未被折叠隐藏、且在 zoom 子树内）的节点，文档先序。 */
  visibleNodes(): OutlineNode[] {
    return this.visibleRows().map((row) => row.node);
  }

  /** 可见节点 + 拖拽/键盘需要的位置信息（深度、父 id、在兄弟中的序号、所属 block）。 */
  visibleRows(): VisibleRow[] {
    const out: VisibleRow[] = [];
    const walk = (
      nodes: readonly OutlineNode[],
      depth: number,
      parentId: string | null,
      blockId: string,
    ): void => {
      for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        out.push({ node, depth, parentId, index, blockId });
        // 搜索中把折叠视作展开：否则命中项藏在折叠子树里根本搜不到
        if (this.searchQuery !== '' || !this.folded.has(node.id)) {
          walk(node.children, depth + 1, node.id, blockId);
        }
      }
    };

    if (this.zoomRootId !== null) {
      const found = locate(this.current, this.zoomRootId);
      if (found) {
        out.push({
          node: found.node,
          depth: 0,
          parentId: found.parent?.id ?? null,
          index: found.index,
          blockId: found.block.id,
        });
        // zoom 根在 renderer 中始终强制展开：它的 children 就是当前页面内容。
        // 键盘可见顺序必须与 DOM 一致，不能继续沿用全文档视图里的 folded 状态，
        // 否则画面能看到子节点，Shift+↓ 却会误判为已到列表末尾。
        walk(found.node.children, 1, found.node.id, found.block.id);
        return out;
      }
    }
    for (const block of this.current.blocks) {
      if (block.kind === 'list') walk(block.roots, 0, null, block.id);
    }
    return out;
  }

  // ---------- 搜索 ----------

  get query(): string {
    return this.searchQuery;
  }

  setSearchQuery(query: string): void {
    if (this.searchQuery === query) return;
    this.searchQuery = query;
    this.emit();
  }

  // ---------- 隐藏已完成 ----------

  get hideCompleted(): boolean {
    return this.hideCompletedState;
  }

  setHideCompleted(value: boolean): void {
    if (this.hideCompletedState === value) return;
    this.hideCompletedState = value;
    this.emit();
  }

  toggleHideCompleted(): void {
    this.setHideCompleted(!this.hideCompletedState);
  }

  // ---------- 侧栏：顶层节点 + 星标书签 ----------

  /** 当前文档所有 ListBlock 的根节点（侧栏顶层导航用）。 */
  topLevelNodes(): OutlineNode[] {
    const out: OutlineNode[] = [];
    for (const block of this.current.blocks) {
      if (block.kind === 'list') out.push(...block.roots);
    }
    return out;
  }

  isStarred(rawId: string): boolean {
    const key = this.keyForId(rawId);
    return key !== null && this.bookmarks.has(key);
  }

  toggleStar(rawId: string): void {
    const key = this.keyForId(rawId);
    if (key === null) return;
    if (this.bookmarks.has(key)) this.bookmarks.delete(key);
    else this.bookmarks.add(key);
    this.scheduleSaveBookmarks();
    this.emit();
  }

  /**
   * 当前文档内被星标的节点（文档先序）与其 id 集合，一次遍历得出。
   * 书签空时提前返回——大文件渲染热路径上不额外遍历（护住 refresh 红线）。
   */
  starred(): { nodes: OutlineNode[]; ids: Set<string> } {
    const ids = new Set<string>();
    const nodes: OutlineNode[] = [];
    if (this.bookmarks.size === 0) return { nodes, ids };
    for (const [id, key] of nodeKeys(this.current.blocks)) {
      if (this.bookmarks.has(key)) ids.add(id);
    }
    const walk = (list: readonly OutlineNode[]): void => {
      for (const node of list) {
        if (ids.has(node.id)) nodes.push(node);
        walk(node.children);
      }
    };
    for (const block of this.current.blocks) if (block.kind === 'list') walk(block.roots);
    return { nodes, ids };
  }

  private scheduleSaveBookmarks(): void {
    if (this.bookmarksTimer !== null) return;
    this.bookmarksTimer = setTimeout(() => {
      this.bookmarksTimer = null;
      this.flushBookmarks();
    }, SAVE_FOLDING_THROTTLE_MS) as unknown as number;
  }

  /** 立即上报星标（blur / 隐藏页面时调用）。书签用 nodeKey，reset 后无需重算。 */
  flushBookmarks(): void {
    if (this.bookmarksTimer !== null) {
      clearTimeout(this.bookmarksTimer);
      this.bookmarksTimer = null;
    }
    this.send({ type: 'saveBookmarks', bookmarkKeys: [...this.bookmarks] });
  }

  private restoreBookmarks(keys: string[]): void {
    this.bookmarks.clear();
    for (const key of keys) this.bookmarks.add(key);
  }

  /** 节点在树中的位置（父 id + 在兄弟中的序号）。 */
  locationOf(id: string): { parentId: string | null; index: number } | null {
    const found = locate(this.current, originalIdOf(id));
    if (!found) return null;
    return { parentId: found.parent?.id ?? null, index: found.index };
  }

  idForKey(key: string): string | null {
    for (const [id, candidate] of nodeKeys(this.current.blocks)) {
      if (candidate === key) return id;
    }
    return null;
  }

  keyForId(id: string): string | null {
    return nodeKeys(this.current.blocks).get(originalIdOf(id)) ?? null;
  }

  // ---------- host → webview ----------

  applyInit(msg: Extract<H2W, { type: 'init' }>): void {
    this.config = msg.config;
    this.reset(msg.snapshot, msg.version, () => {
      this.restoreFolding(msg.foldedKeys);
      this.restoreBookmarks(msg.bookmarkKeys ?? []);
    });
  }

  applyRefresh(msg: Extract<H2W, { type: 'refresh' }>): void {
    // 丢弃未 ack 的本地 op 队列：快照即真相（不做 OT/CRDT，见 docs/04）
    this.reset(msg.snapshot, msg.version);
  }

  applyAck(msg: Extract<H2W, { type: 'ack' }>): void {
    this.baseVersion = msg.version;
    this.inFlight = false;
    if (this.pending.length > 0) this.flushPending();
  }

  private reset(snapshot: DocSnapshot, version: number, afterSwap?: () => void): void {
    this.current = fromSnapshot(snapshot);
    this.baseVersion = version;
    this.pending = [];
    this.inFlight = false;
    this.clearTimer();
    this.mirroredIds = null;
    afterSwap?.();
    // 外部修改走 treeMatch 复用旧 id，折叠/zoom 自然存活；只清理已消失的 id
    for (const id of [...this.folded]) if (!this.findNode(id)) this.folded.delete(id);
    if (this.zoomRootId !== null && !this.findNode(this.zoomRootId)) this.zoomRootId = null;
    this.emit();
  }

  // ---------- webview → host ----------

  /** 结构性 op：先 flush 待发的 setText，本地乐观更新后立即发送。 */
  dispatch(rawOp: Op): boolean {
    return this.dispatchAll([rawOp]);
  }

  /**
   * 一批 op 作为「一次编辑」发出：依次本地乐观应用，合成**单条 edit 消息**——
   * 一条 edit = host 侧一次 workspace.applyEdit = 一个 VS Code undo 步（见 docs/04）。
   * 多选批量操作靠它做到「一次 Cmd+Z 全撤销」。no-op 的 op 不入队（如首个兄弟的 indent）。
   */
  dispatchAll(rawOps: readonly Op[]): boolean {
    this.flushPending();
    let changed = false;
    for (const rawOp of rawOps) {
      const op = normalizeOp(rawOp);
      if (!applyOp(this.current, op).changed) continue;
      this.pending.push(op);
      changed = true;
    }
    if (!changed) return false;
    this.mirroredIds = null;
    this.flushPending();
    this.emit();
    return true;
  }

  /**
   * 文本输入：本地乐观更新 + 防抖发送。
   * 刻意不触发重渲染——DOM 里已经是用户刚敲进去的内容，再 patch 只会打断输入与光标。
   */
  setNodeText(rawId: string, text: string): void {
    const id = originalIdOf(rawId);
    if (!applyOp(this.current, { op: 'setText', id, text }).changed) return;
    this.emitIfMirrored(id);
    const last = this.pending[this.pending.length - 1];
    if (last && last.op === 'setText' && last.id === id) last.text = text;
    else this.pending.push({ op: 'setText', id, text });
    this.scheduleFlush();
  }

  setNodeNote(rawId: string, note: string | null): void {
    const id = originalIdOf(rawId);
    if (!applyOp(this.current, { op: 'setNote', id, note }).changed) return;
    this.emitIfMirrored(id);
    const last = this.pending[this.pending.length - 1];
    if (last && last.op === 'setNote' && last.id === id) last.note = note;
    else this.pending.push({ op: 'setNote', id, note });
    this.scheduleFlush();
  }

  /** 代码块编辑热路径：整块替换 lines。DOM textarea 已是用户输入，不重渲染（同 setNodeText）。 */
  setRawBlockLines(blockId: string, lines: string[]): void {
    if (!applyOp(this.current, { op: 'setRawBlock', id: blockId, lines }).changed) return;
    const last = this.pending[this.pending.length - 1];
    if (last && last.op === 'setRawBlock' && last.id === blockId) last.lines = lines;
    else this.pending.push({ op: 'setRawBlock', id: blockId, lines });
    this.scheduleFlush();
  }

  /**
   * 打字热路径默认不重渲染（DOM 已是用户敲进去的内容）。但如果这个节点还出现在某个
   * 镜像视图里，另一个视图必须跟着变——只有这种情况才补一次 patch，正在编辑的节点
   * 会被 renderer 的「第一原则」跳过，光标不受影响。
   */
  private emitIfMirrored(id: string): void {
    if (this.mirroredIds === null) this.mirroredIds = computeMirroredIds(this.current);
    if (this.mirroredIds.has(id)) this.emit();
  }

  /** 立即发送待发队列（结构 op 前、blur、Ctrl/Cmd+Z、隐藏页面时调用）。 */
  flushPending(): void {
    this.clearTimer();
    if (this.pending.length === 0 || this.inFlight) return;
    const ops = this.pending;
    this.pending = [];
    this.inFlight = true;
    this.send({ type: 'edit', baseVersion: this.baseVersion, seq: ++this.seq, ops });
  }

  private scheduleFlush(): void {
    const now = Date.now();
    if (this.timer === null) this.firstPendingAt = now;
    else clearTimeout(this.timer);

    if (now - this.firstPendingAt >= MAX_PENDING_MS) {
      this.timer = null;
      this.flushPending();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushPending();
    }, SET_TEXT_DEBOUNCE_MS) as unknown as number;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** 被镜像引用的原节点及其整棵子树的 id 集合（这些节点在多个视图里同时出现）。 */
function computeMirroredIds(doc: OutlineDoc): Set<string> {
  const ids = new Set<string>();
  if (!hasMirrors(doc.blocks)) return ids;

  const referenced = new Set<string>();
  const collectRefs = (nodes: readonly OutlineNode[]): void => {
    for (const node of nodes) {
      if (node.mirror !== null) referenced.add(node.mirror);
      collectRefs(node.children);
    }
  };
  const markSubtree = (node: OutlineNode): void => {
    ids.add(node.id);
    for (const child of node.children) markSubtree(child);
  };
  const scan = (nodes: readonly OutlineNode[]): void => {
    for (const node of nodes) {
      if (node.blockId !== null && referenced.has(node.blockId)) markSubtree(node);
      scan(node.children);
    }
  };

  for (const block of doc.blocks) if (block.kind === 'list') collectRefs(block.roots);
  for (const block of doc.blocks) if (block.kind === 'list') scan(block.roots);
  return ids;
}

/** op 里的 id 也可能来自镜像视图，统一归一到数据层 id。 */
function normalizeOp(op: Op): Op {
  if ('id' in op && isComposite(op.id)) op = { ...op, id: originalIdOf(op.id) };
  if ('parentId' in op && typeof op.parentId === 'string' && isComposite(op.parentId)) {
    op = { ...op, parentId: originalIdOf(op.parentId) };
  }
  return op;
}

function isComposite(id: string): boolean {
  return id.includes('/');
}

/** webview 从不序列化，eol / eofNewline 只是为了复用 OutlineDoc 类型（见 docs/02）。 */
function fromSnapshot(snapshot: DocSnapshot): OutlineDoc {
  return { blocks: snapshot.blocks, indentUnit: snapshot.indentUnit, eol: '\n', eofNewline: true };
}

function emptyDoc(): OutlineDoc {
  return { blocks: [], indentUnit: { kind: 'space', width: 2 }, eol: '\n', eofNewline: true };
}
