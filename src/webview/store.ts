// UI 树 + 发送队列（规格见 docs/04「webview 侧：发送队列与防抖」）。
// 本模块不直接操作 DOM，也不直接 postMessage 之外的事；编辑语义一律走 core/ops。

import type { OutlineDoc, OutlineNode } from '../core/model.js';
import { nodeKeys } from '../core/nodeKey.js';
import { applyOp, locate, type Op } from '../core/ops.js';
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

  findNode(id: string): OutlineNode | null {
    return locate(this.current, id)?.node ?? null;
  }

  /** 文档先序里的前一个节点（同一 ListBlock 内），用于 Backspace 合并的落点计算。 */
  previousNode(id: string): OutlineNode | null {
    const found = locate(this.current, id);
    if (!found) return null;
    const order: OutlineNode[] = [];
    const walk = (nodes: OutlineNode[]): void => {
      for (const n of nodes) {
        order.push(n);
        walk(n.children);
      }
    };
    walk(found.block.roots);
    const at = order.findIndex((n) => n.id === id);
    return at > 0 ? order[at - 1] : null;
  }

  // ---------- 折叠 ----------

  get foldedIds(): ReadonlySet<string> {
    return this.folded;
  }

  isFolded(id: string): boolean {
    return this.folded.has(id);
  }

  toggleFold(id: string): void {
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

  zoomTo(id: string | null): void {
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
        if (this.searchQuery !== '' || !this.folded.has(found.node.id)) {
          walk(found.node.children, 1, found.node.id, found.block.id);
        }
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

  /** 节点在树中的位置（父 id + 在兄弟中的序号）。 */
  locationOf(id: string): { parentId: string | null; index: number } | null {
    const found = locate(this.current, id);
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
    return nodeKeys(this.current.blocks).get(id) ?? null;
  }

  // ---------- host → webview ----------

  applyInit(msg: Extract<H2W, { type: 'init' }>): void {
    this.config = msg.config;
    this.reset(msg.snapshot, msg.version, () => this.restoreFolding(msg.foldedKeys));
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
    afterSwap?.();
    // 外部修改走 treeMatch 复用旧 id，折叠/zoom 自然存活；只清理已消失的 id
    for (const id of [...this.folded]) if (!this.findNode(id)) this.folded.delete(id);
    if (this.zoomRootId !== null && !this.findNode(this.zoomRootId)) this.zoomRootId = null;
    this.emit();
  }

  // ---------- webview → host ----------

  /** 结构性 op：先 flush 待发的 setText，本地乐观更新后立即发送。 */
  dispatch(op: Op): boolean {
    this.flushPending();
    if (!applyOp(this.current, op).changed) return false;
    this.pending.push(op);
    this.flushPending();
    this.emit();
    return true;
  }

  /**
   * 文本输入：本地乐观更新 + 防抖发送。
   * 刻意不触发重渲染——DOM 里已经是用户刚敲进去的内容，再 patch 只会打断输入与光标。
   */
  setNodeText(id: string, text: string): void {
    if (!applyOp(this.current, { op: 'setText', id, text }).changed) return;
    const last = this.pending[this.pending.length - 1];
    if (last && last.op === 'setText' && last.id === id) last.text = text;
    else this.pending.push({ op: 'setText', id, text });
    this.scheduleFlush();
  }

  setNodeNote(id: string, note: string | null): void {
    if (!applyOp(this.current, { op: 'setNote', id, note }).changed) return;
    const last = this.pending[this.pending.length - 1];
    if (last && last.op === 'setNote' && last.id === id) last.note = note;
    else this.pending.push({ op: 'setNote', id, note });
    this.scheduleFlush();
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

/** webview 从不序列化，eol / eofNewline 只是为了复用 OutlineDoc 类型（见 docs/02）。 */
function fromSnapshot(snapshot: DocSnapshot): OutlineDoc {
  return { blocks: snapshot.blocks, indentUnit: snapshot.indentUnit, eol: '\n', eofNewline: true };
}

function emptyDoc(): OutlineDoc {
  return { blocks: [], indentUnit: { kind: 'space', width: 2 }, eol: '\n', eofNewline: true };
}
