// 单节点 DOM 构建（结构见 docs/05）。
// 只负责「一个节点 → 一段 DOM」，不感知树的增删改顺序（那是 renderer 的事）。

import type { OutlineNode } from '../core/model.js';
import type { MirrorState } from './mirror.js';

export interface UpdateOptions {
  /** 该节点正在被编辑（focus 在内且文本未变 / IME 组合中）→ 不碰它的文本 DOM。 */
  skipText: boolean;
  folded: boolean;
  /** 树深度（0 起），转成 aria-level（1 起）。 */
  depth: number;
  /** 镜像展开状态（见 docs/06）。 */
  mirrorState?: MirrorState | undefined;
  /** 镜像行在文件里带着子行：渲染层忽略，UI 提示。 */
  ignoredChildren?: boolean | undefined;
}

export class NodeView {
  readonly el: HTMLElement;
  readonly childrenEl: HTMLElement;
  private readonly row: HTMLElement;
  private readonly toggleEl: HTMLButtonElement;
  private readonly textEl: HTMLElement;
  private badgeEl: HTMLElement | null = null;
  private noteEl: HTMLElement | null = null;
  private hintEl: HTMLElement | null = null;

  constructor(
    node: OutlineNode,
    opts: { folded: boolean; depth: number; mirrorState?: MirrorState | undefined },
  ) {
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

    this.update(node, {
      skipText: false,
      folded: opts.folded,
      depth: opts.depth,
      mirrorState: opts.mirrorState,
    });
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

    this.syncMirrorState(opts);

    this.row.classList.toggle('checked', node.checked === true);
    this.row.classList.toggle('task', node.checked !== null);
    this.row.classList.toggle('mirror', node.mirror !== null);
    this.el.classList.toggle('has-children', node.children.length > 0);
    this.toggleEl.style.visibility = node.children.length > 0 ? 'visible' : 'hidden';

    this.syncBadge(node);
    this.syncNote(node, opts);
  }

  /**
   * 镜像状态：展开出来的镜像行可编辑（编辑落到原节点）；断链与循环引用是只读占位，
   * 保留原文 `![[#^id]]`，绝不静默删除、不丢数据（见 docs/06）。
   */
  private syncMirrorState(opts: UpdateOptions): void {
    const state = opts.mirrorState ?? 'none';
    this.el.classList.toggle('mirror-view', state === 'mirror');
    this.el.classList.toggle('mirror-broken', state === 'broken');
    this.el.classList.toggle('mirror-cycle', state === 'cycle');

    const readOnly = state === 'broken' || state === 'cycle';
    this.textEl.contentEditable = readOnly ? 'false' : 'plaintext-only';

    const hint = readOnly ? (state === 'broken' ? '断链引用' : '循环引用') : null;
    if (hint === null) {
      this.hintEl?.remove();
      this.hintEl = null;
    } else {
      if (this.hintEl === null) {
        this.hintEl = document.createElement('span');
        this.hintEl.className = 'mirror-hint';
        this.row.append(this.hintEl);
      }
      this.hintEl.textContent = hint;
    }

    this.el.classList.toggle('has-ignored-children', opts.ignoredChildren === true);
    if (opts.ignoredChildren === true) {
      this.row.title = '镜像行下的子行不参与渲染（数据保留在文件里）';
    } else if (this.row.title !== '') {
      this.row.removeAttribute('title');
    }
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
