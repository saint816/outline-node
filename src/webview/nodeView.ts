// 单节点 DOM 构建（结构见 docs/05）。
// 只负责「一个节点 → 一段 DOM」，不感知树的增删改顺序（那是 renderer 的事）。

import type { OutlineNode } from '../core/model.js';

export interface UpdateOptions {
  /** 该节点正在被编辑（focus 在内且文本未变 / IME 组合中）→ 不碰它的文本 DOM。 */
  skipText: boolean;
  folded: boolean;
  /** 树深度（0 起），转成 aria-level（1 起）。 */
  depth: number;
}

export class NodeView {
  readonly el: HTMLElement;
  readonly childrenEl: HTMLElement;
  private readonly row: HTMLElement;
  private readonly toggleEl: HTMLButtonElement;
  private readonly textEl: HTMLElement;
  private badgeEl: HTMLElement | null = null;
  private noteEl: HTMLElement | null = null;

  constructor(node: OutlineNode, opts: { folded: boolean; depth: number }) {
    this.el = div('node');
    this.el.dataset.id = node.id;
    this.el.setAttribute('role', 'treeitem');

    this.row = div('node-row');
    this.toggleEl = document.createElement('button');
    this.toggleEl.className = 'toggle';
    this.toggleEl.type = 'button';
    this.toggleEl.tabIndex = -1;
    this.toggleEl.setAttribute('aria-expanded', 'true');

    const bullet = div('bullet');
    bullet.setAttribute('aria-hidden', 'true');

    this.textEl = div('text');
    this.textEl.contentEditable = 'plaintext-only';
    this.textEl.spellcheck = false;
    this.textEl.dataset.field = 'text';
    this.textEl.setAttribute('role', 'textbox');
    this.textEl.setAttribute('aria-multiline', 'false');

    this.row.append(this.toggleEl, bullet, this.textEl);
    this.childrenEl = div('children');
    this.childrenEl.setAttribute('role', 'group');
    this.el.append(this.row, this.childrenEl);

    this.update(node, { skipText: false, folded: opts.folded, depth: opts.depth });
  }

  update(node: OutlineNode, opts: UpdateOptions): void {
    if (this.el.dataset.id !== node.id) this.el.dataset.id = node.id;

    this.el.setAttribute('aria-level', String(opts.depth + 1));
    this.el.setAttribute('aria-selected', 'false');
    this.toggleEl.setAttribute('aria-expanded', opts.folded ? 'false' : 'true');
    this.toggleEl.setAttribute('aria-label', opts.folded ? '展开' : '折叠');
    this.el.classList.toggle('folded', opts.folded);

    if (!opts.skipText && this.textEl.textContent !== node.text) {
      this.textEl.textContent = node.text;
    }

    this.row.classList.toggle('checked', node.checked === true);
    this.row.classList.toggle('task', node.checked !== null);
    this.row.classList.toggle('mirror', node.mirror !== null);
    this.el.classList.toggle('has-children', node.children.length > 0);
    this.toggleEl.style.visibility = node.children.length > 0 ? 'visible' : 'hidden';

    this.syncBadge(node);
    this.syncNote(node, opts);
  }

  /** blockId 只显示成小徽标，text 里不含 ^id（见 docs/05、06）。 */
  private syncBadge(node: OutlineNode): void {
    if (node.blockId === null) {
      this.badgeEl?.remove();
      this.badgeEl = null;
      return;
    }
    if (this.badgeEl === null) {
      this.badgeEl = document.createElement('span');
      this.badgeEl.className = 'block-id-badge';
      this.row.append(this.badgeEl);
    }
    this.badgeEl.textContent = '^' + node.blockId;
    this.badgeEl.title = 'block id: ' + node.blockId;
  }

  private syncNote(node: OutlineNode, opts: UpdateOptions): void {
    if (node.note === null) {
      if (this.noteEl !== null && !opts.skipText) {
        this.noteEl.remove();
        this.noteEl = null;
      }
      return;
    }
    if (this.noteEl === null) {
      this.noteEl = div('note');
      this.noteEl.contentEditable = 'plaintext-only';
      this.noteEl.spellcheck = false;
      this.noteEl.dataset.field = 'note';
      this.el.insertBefore(this.noteEl, this.childrenEl);
    }
    // note 用 innerText 读写以保留换行（见 docs/05）
    if (!opts.skipText && this.noteEl.innerText !== node.note) this.noteEl.innerText = node.note;
  }
}

export function createRawBlockView(lines: string[]): HTMLElement {
  const pre = document.createElement('pre');
  pre.className = 'raw-block';
  updateRawBlockView(pre, lines);
  return pre;
}

export function updateRawBlockView(pre: HTMLElement, lines: string[]): void {
  const text = lines.join('\n');
  if (pre.textContent !== text) pre.textContent = text;
  // 仅含空行的 RawBlock 渲染成细分隔，让被空行拆开的列表在视觉上连续（纯样式，不改模型）
  pre.classList.toggle('blank', lines.every((line) => line.trim() === ''));
}

function div(className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}
