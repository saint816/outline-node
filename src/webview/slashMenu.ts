// 斜杠插入菜单：在光标处输入 `/` 弹出可过滤菜单，选中即把当前节点
// 转成对应类型。只调 store.dispatch + UI 状态，不直接 postMessage、不改树（同其余交互模块）。
//
// 触发：`/` 位于词首（行首或紧跟空白）且光标在正文（text 字段）。`/` 后到光标的连续非空白
// 串是过滤 query。无匹配时只显示占位提示、不拦截 Enter（让普通拆分照常发生）。
//
// 条目复用现有 op：代码块 setText+setNote（挂到该节点下，节点保留 bullet）。
// 所有条目都先删掉 `/query` 再转换。

import type { CaretPos } from './caret.js';
import { caretRect, saveCaret } from './caret.js';
import { emptyFence } from './codeFence.js';
import { t } from './i18n.js';
import type { OutlineNode } from '../core/model.js';
import type { Store } from './store.js';
import { canMakeDivider } from '../core/divider.js';

export interface SlashMenuContext {
  store: Store;
  newId(): string;
  setNextCaret(pos: CaretPos): void;
  focusCodeBlock(blockId: string): void;
  focusNoteCode(nodeId: string): void;
}

interface SlashItem {
  key: 'code' | 'divider';
  label: () => string;
  hint?: () => string;
  keywords: string[];
  enabled(node: OutlineNode, ctx: SlashMenuContext, textWithoutToken: string): boolean;
}

const ITEMS: SlashItem[] = [
  {
    key: 'divider',
    label: () => t('divider.label'),
    keywords: ['divider', 'separator', 'hr', '分隔线'],
    enabled: (node) => canMakeDivider(node),
  },
  {
    key: 'code',
    label: () => t('slash.codeBlock'),
    keywords: ['code', 'codeblock', 'fence', '代码', '代码块', '```'],
    // 任何节点都能挂代码块（写进该节点的 note）。已有备注的节点除外：
    // note 只有一份，代码块会顶掉原备注。
    enabled: (node) => node.note === null && node.mirror === null,
  },
];

/** `/query` token：从光标回扫到词首的 `/`（其前须是行首或空白）。 */
function slashToken(text: string, caret: number): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0 && text[i] !== '/' && !/\s/.test(text[i])) i--;
  if (i < 0 || text[i] !== '/') return null;
  if (i > 0 && !/\s/.test(text[i - 1])) return null;
  return { start: i, query: text.slice(i + 1, caret) };
}

function removeSlashToken(text: string, start: number, end: number): string {
  return text.slice(0, start).trimEnd() + text.slice(end);
}

export class SlashMenu {
  private readonly el: HTMLElement;
  private open = false;
  private nodeId: string | null = null;
  private start = 0;
  private end = 0;
  private results: SlashItem[] = [];
  private selected = 0;
  /** Esc 忽略过的 token 起点：同一个 `/` token 不再自动弹出（-1 = 无）。 */
  private dismissed = -1;

  constructor(private readonly ctx: SlashMenuContext) {
    this.el = document.createElement('div');
    this.el.className = 'slash-menu';
    this.el.setAttribute('role', 'listbox');
    this.el.setAttribute('aria-label', t('slash.ariaLabel'));
    this.el.hidden = true;
    // 用 mousedown（早于 blur）选中，避免点击时正文先失焦丢掉 saveCaret
    this.el.addEventListener('mousedown', (e) => this.onMouseDown(e));
    document.body.appendChild(this.el);
  }

  isOpen(): boolean {
    return this.open;
  }

  /** 文本变化后重算 token → 开 / 更新 / 关。由 input 委托在 setNodeText 之后调用。 */
  sync(): void {
    const caret = saveCaret();
    if (!caret || caret.field !== 'text') return this.close();
    const node = this.ctx.store.findNode(caret.nodeId);
    if (!node) return this.close();
    const token = slashToken(node.text, caret.offset);
    if (!token) return this.close(); // token 消失（删掉了 /）→ 复位，dismissed 一并清
    if (token.start === this.dismissed) return this.hideMenu(); // 这个 token 被 Esc 忽略过

    this.nodeId = caret.nodeId;
    this.start = token.start;
    this.end = caret.offset;
    const q = token.query.toLowerCase();
    const textWithoutToken = removeSlashToken(node.text, token.start, caret.offset);
    this.results = ITEMS.filter(
      (it) =>
        it.enabled(node, this.ctx, textWithoutToken) &&
        (q === '' || it.keywords.some((k) => k.includes(q))),
    );
    this.selected = 0;
    this.open = true;
    this.render();
  }

  /**
   * 菜单激活时优先处理导航键；返回 true = 已消费（keymap 不应再处理）。
   * 无匹配（results 为空）时只吞 Esc，其余放行——让 Enter 走普通拆分。
   */
  handleKeydown(e: KeyboardEvent): boolean {
    if (!this.open) return false;
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        this.dismissed = this.start; // 记住这个 token，别在继续打字时又弹出
        this.hideMenu();
        return true;
      case 'ArrowDown':
        if (this.results.length === 0) return false;
        e.preventDefault();
        this.selected = (this.selected + 1) % this.results.length;
        this.render();
        return true;
      case 'ArrowUp':
        if (this.results.length === 0) return false;
        e.preventDefault();
        this.selected = (this.selected - 1 + this.results.length) % this.results.length;
        this.render();
        return true;
      case 'Enter':
      case 'Tab':
        if (this.results.length === 0) return false;
        e.preventDefault();
        this.choose();
        return true;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'Home':
      case 'End':
        // 光标要移出 token，关掉菜单但放行按键
        this.close();
        return false;
      default:
        return false;
    }
  }

  /** 完全复位（含清掉 Esc 忽略记录）：焦点离开、token 消失、选定后调用。 */
  close(): void {
    this.dismissed = -1;
    this.hideMenu();
  }

  /** 只收起菜单，保留 dismissed（Esc 忽略当前 token 时用）。 */
  private hideMenu(): void {
    if (!this.open) return;
    this.open = false;
    this.nodeId = null;
    this.el.hidden = true;
    this.el.replaceChildren();
  }

  private onMouseDown(e: MouseEvent): void {
    const row = (e.target as HTMLElement | null)?.closest<HTMLElement>('.slash-item');
    const idx = row?.dataset.index;
    if (idx === undefined) return;
    e.preventDefault(); // 别让正文失焦
    const item = this.results[Number(idx)];
    if (item) {
      this.selected = Number(idx);
      this.choose();
    }
  }

  private choose(): void {
    if (this.nodeId === null) return this.close();
    const node = this.ctx.store.findNode(this.nodeId);
    if (!node) return this.close();

    // 先删掉 /query，再转换；光标落到删除处
    const newText = removeSlashToken(node.text, this.start, this.end);

    if (this.results[this.selected]?.key === 'divider') {
      const text = newText.trim() === '' ? '***' : newText;
      this.ctx.setNextCaret({ nodeId: node.id, field: 'text', offset: text.length });
      this.ctx.store.dispatchAll([
        { op: 'setText', id: node.id, text },
        { op: 'setNote', id: node.id, note: newText.trim() === '' ? null : '***' },
      ]);
      return this.close();
    }

    // 一律挂到该节点下（见 docs/05「代码块」），顶层空壳也不例外——转成文档级块会丢掉
    // bullet，拖不动也缩进不了（实机反馈）。一次 dispatchAll = 一个 undo 步
    // 空标题也允许先创建，随后把光标留在始终可见的标题行要求补填；不能为了“标题必填”
    // 把 Code 入口藏掉，否则用户连代码块都无法触发。
    if (newText.trim() === '') {
      this.ctx.setNextCaret({ nodeId: node.id, field: 'text', offset: 0 });
    } else {
      this.ctx.focusNoteCode(node.id);
    }
    this.ctx.store.dispatchAll([
      { op: 'setText', id: node.id, text: newText },
      { op: 'setNote', id: node.id, note: emptyFence('') },
    ]);
    return this.close();
  }

  private render(): void {
    this.el.replaceChildren();
    if (this.results.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'slash-empty';
      empty.textContent = t('slash.noResults');
      this.el.append(empty);
    } else {
      this.results.forEach((item, i) => {
        const row = document.createElement('div');
        row.className = 'slash-item' + (i === this.selected ? ' selected' : '');
        row.dataset.index = String(i);
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(i === this.selected));
        const label = document.createElement('span');
        label.className = 'slash-label';
        label.textContent = item.label();
        row.append(label);
        if (item.hint) {
          const hint = document.createElement('span');
          hint.className = 'slash-hint';
          hint.textContent = item.hint();
          row.append(hint);
        }
        this.el.append(row);
      });
    }
    this.el.hidden = false;
    this.position();
  }

  private position(): void {
    const rect = caretRect();
    const top = (rect ? rect.bottom : 80) + 4;
    const left = rect ? rect.left : 80;
    this.el.style.top = `${Math.round(top)}px`;
    this.el.style.left = `${Math.round(left)}px`;
  }
}
