// UI 树 + 发送队列（规格见 docs/04「webview 侧：发送队列与防抖」）。
// 本模块不直接操作 DOM，也不直接 postMessage 之外的事；编辑语义一律走 core/ops。

import type { OutlineDoc, OutlineNode } from '../core/model.js';
import { applyOp, locate, type Op } from '../core/ops.js';
import type { DocSnapshot, EditorConfig, H2W, W2H } from '../shared/protocol.js';

const SET_TEXT_DEBOUNCE_MS = 300;
/** 连续输入超过这个时长强制 flush，限制丢失窗口与 undo 步长。 */
const MAX_PENDING_MS = 1000;

export class Store {
  private current: OutlineDoc = emptyDoc();
  private baseVersion = 0;
  private seq = 0;
  private pending: Op[] = [];
  private inFlight = false;
  private timer: number | null = null;
  private firstPendingAt = 0;
  private readonly listeners: (() => void)[] = [];

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

  // ---------- host → webview ----------

  applyInit(msg: Extract<H2W, { type: 'init' }>): void {
    this.config = msg.config;
    this.reset(msg.snapshot, msg.version);
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

  private reset(snapshot: DocSnapshot, version: number): void {
    this.current = fromSnapshot(snapshot);
    this.baseVersion = version;
    this.pending = [];
    this.inFlight = false;
    this.clearTimer();
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
