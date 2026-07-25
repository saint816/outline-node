// 节点多选（Workflowy 语义）：Shift+↑/↓ 扩选、Shift+点击 选一段，然后
// Tab / Shift+Tab / Alt+↑↓ / Cmd+Enter / Backspace / Cmd+C 批量作用在整个选区上。
//
// 纯 webview UI 状态：不落用户文件、不改协议、不新增 op——批量操作复用既有 op，
// 经 store.dispatchAll 合成**一条 edit 消息** = 一个 VS Code undo 步（见 docs/04）。
// 镜像视图（复合 id `mirrorId/originalId`，见 docs/06）不参与多选：那里的行不在
// 数据层 visibleRows 里，区间语义无从定义。

import type { OutlineNode } from '../core/model.js';
import type { Op } from '../core/ops.js';
import {
  atFirstVisualLine,
  atLastVisualLine,
  findEditable,
  saveCaret,
  type CaretPos,
} from './caret.js';
import type { Store } from './store.js';

export class NodeSelection {
  private anchorId: string | null = null;
  private headId: string | null = null;
  /** 当前打了 .selected 的元素：清除时只碰它们，无选区时零成本（护住 refresh 红线，见 docs/07）。 */
  private marked: HTMLElement[] = [];

  constructor(
    private readonly store: Store,
    private readonly root: HTMLElement,
  ) {}

  get active(): boolean {
    return this.anchorId !== null;
  }

  get anchor(): string | null {
    return this.anchorId;
  }

  /** 以某节点为锚点开始一段选区（此刻只含它自己，扩一格后才是真正的多选）。 */
  begin(id: string): void {
    this.anchorId = id;
    this.headId = id;
  }

  setRange(anchorId: string, headId: string): void {
    this.anchorId = anchorId;
    this.headId = headId;
    this.syncHighlight();
  }

  clear(): void {
    if (this.anchorId === null && this.marked.length === 0) return;
    this.anchorId = null;
    this.headId = null;
    this.syncHighlight();
  }

  /** 把选区活动端朝 dir 挪一格（可见先序）；到头返回 false。 */
  extend(dir: -1 | 1): boolean {
    if (this.headId === null) return false;
    const order = this.store.visibleNodes();
    const at = order.findIndex((n) => n.id === this.headId);
    if (at === -1) return false;
    const next = order[at + dir];
    if (!next) return false;
    this.headId = next.id;
    this.syncHighlight();
    return true;
  }

  /**
   * 选中的**子树根**（文档先序）：祖先已入选时后代被吸收。批量 op 只作用在根上，
   * 子树自然跟着走——既符合 Workflowy 的「选中就是选中整棵」，也避免 indent/move
   * 对同一棵子树重复施加。
   */
  roots(): string[] {
    if (this.anchorId === null || this.headId === null) return [];
    const rows = this.store.visibleRows();
    const a = rows.findIndex((r) => r.node.id === this.anchorId);
    const h = rows.findIndex((r) => r.node.id === this.headId);
    if (a === -1 || h === -1) return [];
    const [lo, hi] = a <= h ? [a, h] : [h, a];

    const inRange = new Set<string>();
    for (let i = lo; i <= hi; i++) inRange.add(rows[i].node.id);
    const parentOf = new Map<string, string | null>();
    for (const row of rows) parentOf.set(row.node.id, row.parentId);

    const out: string[] = [];
    for (let i = lo; i <= hi; i++) {
      let parent = parentOf.get(rows[i].node.id) ?? null;
      let covered = false;
      while (parent !== null) {
        if (inRange.has(parent)) {
          covered = true;
          break;
        }
        parent = parentOf.get(parent) ?? null;
      }
      if (!covered) out.push(rows[i].node.id);
    }
    return out;
  }

  /** 选中的子树根节点（复制用）。 */
  nodes(): OutlineNode[] {
    const out: OutlineNode[] = [];
    for (const id of this.roots()) {
      const node = this.store.findNode(id);
      if (node) out.push(node);
    }
    return out;
  }

  // ---------- 批量操作（复用既有 op，一次 dispatchAll = 一个 undo 步） ----------

  indent(outdent: boolean): void {
    const roots = this.roots();
    if (roots.length === 0) return this.clear();
    // 反缩进必须逆序：outdent 把节点插到原父节点之后，正序会让选中项相对顺序颠倒
    const ids = outdent ? [...roots].reverse() : roots;
    this.store.dispatchAll(ids.map((id): Op => ({ op: outdent ? 'outdent' : 'indent', id })));
  }

  move(dir: -1 | 1): void {
    const roots = this.roots();
    if (roots.length === 0) return this.clear();
    // 下移同理要逆序，否则靠前的一项会先跨过靠后的一项
    const ids = dir === -1 ? roots : [...roots].reverse();
    this.store.dispatchAll(ids.map((id): Op => ({ op: dir === -1 ? 'moveUp' : 'moveDown', id })));
  }

  /** 全部已完成 → 全部取消；否则全部标完成（用 setChecked 而非 toggleChecked，见 docs/04）。 */
  toggleChecked(): void {
    const roots = this.roots();
    if (roots.length === 0) return this.clear();
    const allChecked = roots.every((id) => this.store.findNode(id)?.checked === true);
    this.store.dispatchAll(roots.map((id): Op => ({ op: 'setChecked', id, checked: !allChecked })));
  }

  /** 删除选中的整棵子树；光标落到选区前一行，没有前一行则落到选区之后第一行。 */
  deleteSelected(setNextCaret: (pos: CaretPos) => void): void {
    const roots = this.roots();
    if (roots.length === 0) return this.clear();
    const target = this.caretTargetAfterDelete(roots);
    if (target !== null) setNextCaret({ nodeId: target, field: 'text', offset: 0 });
    this.store.dispatchAll(roots.map((id): Op => ({ op: 'delete', id })));
    this.clear();
  }

  private caretTargetAfterDelete(roots: string[]): string | null {
    const rows = this.store.visibleRows();
    const rootSet = new Set(roots);
    const covered = new Set<string>(); // 选中的根 + 其全部后代（都会随 delete 消失）
    for (const row of rows) {
      if (rootSet.has(row.node.id) || (row.parentId !== null && covered.has(row.parentId))) {
        covered.add(row.node.id);
      }
    }
    const first = rows.findIndex((r) => covered.has(r.node.id));
    if (first === -1) return null;
    if (first > 0) return rows[first - 1].node.id;
    return rows.slice(first).find((r) => !covered.has(r.node.id))?.node.id ?? null;
  }

  /**
   * 只增删 class、不动 DOM 结构（同搜索过滤的思路，见 docs/07）。
   * 选中的是子树根，CSS 让整棵子树跟着高亮 —— 与批量 op 的作用范围一致。
   */
  syncHighlight(): void {
    if (this.marked.length === 0 && !this.active) return;
    for (const el of this.marked) el.classList.remove('selected');
    this.marked = [];
    if (!this.active) return;
    for (const id of this.roots()) {
      const el = this.root.querySelector<HTMLElement>(`.node[data-id="${cssEscape(id)}"]`);
      if (el) {
        el.classList.add('selected');
        this.marked.push(el);
      }
    }
  }
}

export interface SelectionKeyContext {
  selection: NodeSelection;
  /** patch 之后把光标放到这里（批量删除后的落点）。 */
  setNextCaret(pos: CaretPos): void;
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

/** 返回 true = 本次按键已被多选消费，keymap 不再处理。 */
export function handleSelectionKeydown(e: KeyboardEvent, ctx: SelectionKeyContext): boolean {
  if (e.isComposing || e.key === 'Process') return false; // 组合期间绝不动结构（红线 4）
  const sel = ctx.selection;
  const mod = e.metaKey || e.ctrlKey;

  // Shift+↑/↓：在首/末视觉行进入多选（与 ↑/↓ 跨节点移动同一判据），之后每按一次扩一格
  if (e.shiftKey && !mod && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    const dir = e.key === 'ArrowUp' ? -1 : 1;
    if (sel.active) {
      e.preventDefault();
      sel.extend(dir);
      return true;
    }
    const caret = saveCaret();
    if (!caret || caret.nodeId.includes('/')) return false; // 镜像视图不参与多选
    const editable = findEditable(caret.nodeId, caret.field);
    if (!editable) return false;
    // 节点内还能继续扩文本选区时不抢：交给浏览器（Workflowy 也是先选文本再选节点）
    if (dir === -1 ? !atFirstVisualLine(editable) : !atLastVisualLine(editable)) return false;
    sel.begin(caret.nodeId);
    if (!sel.extend(dir)) {
      sel.clear();
      return false;
    }
    e.preventDefault();
    collapseNativeSelection(); // 去掉残留的文本选区高亮，视觉上只剩节点选区
    return true;
  }

  if (!sel.active) return false;

  if (e.key === 'Escape') {
    e.preventDefault();
    sel.clear();
    return true;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    sel.indent(e.shiftKey);
    return true;
  }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    sel.move(e.key === 'ArrowUp' ? -1 : 1);
    return true;
  }
  if (mod && e.key === 'Enter') {
    e.preventDefault();
    sel.toggleChecked();
    return true;
  }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    sel.deleteSelected(ctx.setNextCaret);
    return true;
  }
  if (mod) {
    // Cmd/Ctrl+C / X 由 clipboard.ts 的 copy/cut 事件读选区处理，这里放行
    if (e.key === 'z' || e.key === 'Z') sel.clear(); // undo 会重塑整棵树，选区随即失效
    return false;
  }
  // 其余单键（打字、光标键…）退出多选，交回普通编辑
  if (!MODIFIER_KEYS.has(e.key)) sel.clear();
  return false;
}

function collapseNativeSelection(): void {
  const native = window.getSelection();
  if (native && !native.isCollapsed) native.collapseToStart();
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
