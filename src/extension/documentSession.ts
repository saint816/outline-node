// 同步协议 host 侧（规格见 docs/04-sync-protocol.md）。每个 webviewPanel 一个实例。
// 本模块不实现编辑语义（一律调 core/ops 的 applyOp），也不碰 DOM 概念。

import type { OutlineDoc } from '../core/model.js';
import { minimalEdits, type TextEditSpan } from '../core/lineDiff.js';
import { applyOp } from '../core/ops.js';
import { parseOutline } from '../core/parser.js';
import { serializeOutline } from '../core/serializer.js';
import { matchTrees } from '../core/treeMatch.js';
import { toSnapshot, type DocSnapshot, type EditorConfig, type H2W, type W2H } from '../shared/protocol.js';
import type { FoldingStore, UriLike } from './foldingStore.js';
import type { BookmarkStore } from './bookmarkStore.js';

/**
 * session 用到的宿主能力。
 * SPEC-GAP: docs/04 写的构造签名是 (document, webview, folding, config)，但 docs/09
 * 要求「DocumentSession 的 vscode 依赖收窄为可注入接口」以便跑协议剧本测试。这里采用
 * docs/09 的形态：vscode 相关的拼装留在 outlineEditorProvider。executeRedo 是 docs/09
 * 接口里漏写的一项（W2H 有 requestRedo）。
 */
export interface SessionHost {
  readonly uri: UriLike;
  readonly version: number;
  getText(): string;
  applyEdit(spans: TextEditSpan[]): Promise<boolean>;
  postMessage(msg: H2W): void;
  executeUndo(): void | Promise<void>;
  executeRedo(): void | Promise<void>;
}

const EXTERNAL_DEBOUNCE_MS = 100;

export class DocumentSession {
  /** 带 raw 的权威树，序列化依据。 */
  private mirrorDoc: OutlineDoc;
  /** 回声队列：等待被 onDocumentChanged 认领的预期文本。 */
  private expected: { text: string; seq: number }[] = [];
  private externalTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUndo = false;
  private foldedKeys: string[] | null = null;
  private bookmarkKeys: string[] | null = null;
  private disposed = false;

  constructor(
    private readonly host: SessionHost,
    private readonly folding: FoldingStore,
    private readonly config: EditorConfig,
    private readonly bookmarks?: BookmarkStore,
  ) {
    this.mirrorDoc = this.parse(host.getText());
  }

  /** 当前权威树的快照（webview 之外只有集成测试会用）。 */
  snapshot(): DocSnapshot {
    return toSnapshot(this.mirrorDoc);
  }

  async handleMessage(msg: W2H): Promise<void> {
    if (this.disposed) return;
    switch (msg.type) {
      case 'ready':
        this.post({
          type: 'init',
          snapshot: toSnapshot(this.mirrorDoc),
          version: this.host.version,
          foldedKeys: this.config.rememberFolding ? this.folding.load(this.host.uri) : [],
          bookmarkKeys: this.bookmarks ? this.bookmarks.load(this.host.uri) : [],
          config: this.config,
        });
        return;
      case 'edit':
        await this.handleEdit(msg);
        return;
      case 'requestUndo':
        await this.forwardHistory(() => this.host.executeUndo());
        return;
      case 'requestRedo':
        await this.forwardHistory(() => this.host.executeRedo());
        return;
      case 'saveFolding':
        this.foldedKeys = msg.foldedKeys;
        if (this.config.rememberFolding) this.folding.save(this.host.uri, msg.foldedKeys);
        return;
      case 'saveBookmarks':
        this.bookmarkKeys = msg.bookmarkKeys;
        this.bookmarks?.save(this.host.uri, msg.bookmarkKeys);
        return;
    }
  }

  /** provider 转发文档变更事件（回声判定入口）。 */
  onDocumentChanged(): void {
    if (this.disposed) return;
    const text = this.host.getText();

    // 用内容比对而非计数器：天然扛住 applyEdit 合并、失败等边界
    if (this.expected.length > 0 && this.expected[0].text === text) {
      const { seq } = this.expected.shift()!;
      this.post({ type: 'ack', seq, version: this.host.version });
      return;
    }

    // 外部修改：旧的预期文本已失效
    this.expected.length = 0;
    this.scheduleExternalRefresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.externalTimer !== null) clearTimeout(this.externalTimer);
    this.externalTimer = null;
    if (this.config.rememberFolding && this.foldedKeys !== null) {
      this.folding.save(this.host.uri, this.foldedKeys);
    }
    if (this.bookmarks && this.bookmarkKeys !== null) {
      this.bookmarks.save(this.host.uri, this.bookmarkKeys);
    }
  }

  /**
   * undo/redo 转发。命令执行完文本仍没变（没什么可撤销）时必须撤下 pendingUndo，
   * 否则这个陈旧标志会把下一次真正的外部修改误标成 cause:'undo'。
   */
  private async forwardHistory(execute: () => void | Promise<void>): Promise<void> {
    const before = this.host.getText();
    this.pendingUndo = true;
    await execute();
    if (this.host.getText() === before) this.pendingUndo = false;
  }

  // ---------- edit ----------

  private async handleEdit(msg: Extract<W2H, { type: 'edit' }>): Promise<void> {
    if (msg.baseVersion !== this.host.version) {
      this.postRefresh('conflict');
      return;
    }

    let changed = false;
    for (const op of msg.ops) {
      if (applyOp(this.mirrorDoc, op).changed) changed = true;
    }
    if (!changed) {
      this.post({ type: 'ack', seq: msg.seq, version: this.host.version });
      return;
    }

    const newText = serializeOutline(this.mirrorDoc);
    const edits = minimalEdits(this.host.getText(), newText);
    if (edits.length === 0) {
      this.post({ type: 'ack', seq: msg.seq, version: this.host.version });
      return;
    }

    this.expected.push({ text: newText, seq: msg.seq });
    const applied = await this.host.applyEdit(edits);
    if (this.disposed) return;
    if (!applied) {
      // 罕见：文档被关闭 / 竞态。撤下预期，按当前文本重建 mirrorDoc
      this.expected = this.expected.filter((e) => e.seq !== msg.seq);
      this.resync();
      this.postRefresh('conflict');
    }
  }

  // ---------- 外部修改 ----------

  private scheduleExternalRefresh(): void {
    if (this.externalTimer !== null) clearTimeout(this.externalTimer);
    this.externalTimer = setTimeout(() => {
      this.externalTimer = null;
      if (this.disposed) return;
      this.resync();
      this.postRefresh(this.pendingUndo ? 'undo' : 'external');
      this.pendingUndo = false;
    }, EXTERNAL_DEBOUNCE_MS);
  }

  /** 按当前文档文本重建 mirrorDoc，尽量复用旧 id（折叠与光标据此存活）。 */
  private resync(): void {
    const newDoc = this.parse(this.host.getText());
    matchTrees(this.mirrorDoc, newDoc);
    this.mirrorDoc = newDoc;
  }

  private parse(text: string): OutlineDoc {
    return parseOutline(text, { defaultIndent: this.config.defaultIndent });
  }

  private postRefresh(cause: 'external' | 'undo' | 'conflict'): void {
    this.post({
      type: 'refresh',
      snapshot: toSnapshot(this.mirrorDoc),
      version: this.host.version,
      cause,
    });
  }

  private post(msg: H2W): void {
    this.host.postMessage(msg);
  }
}
