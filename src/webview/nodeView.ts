// 单节点 DOM 构建（结构见 docs/05）。
// 只负责「一个节点 → 一段 DOM」，不感知树的增删改顺序（那是 renderer 的事）。

import type { OutlineNode } from '../core/model.js';
import { parseFence, renderFence, type CodeFence } from './codeFence.js';
import { t } from './i18n.js';
import { isImageOnly, parseImages, wholeLineImage, type ParsedImage } from './images.js';
import { hasInlineMarkup, isRendered, renderInline, toSourceMode } from './inline.js';
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
  private readonly bulletEl: HTMLElement;
  private readonly textEl: HTMLElement;
  private badgeEl: HTMLElement | null = null;
  private noteEl: HTMLElement | null = null;
  /** note 整体是围栏代码块时的代码块 DOM（与 noteEl 二选一，见 syncNote）。 */
  private noteCodeEl: HTMLElement | null = null;
  /** 代码块是否挂在节点行内（正文为空的「代码块节点」）。 */
  private noteCodeInline = false;
  private hintEl: HTMLElement | null = null;
  private imagesEl: HTMLElement | null = null;
  private imagesKey = '';
  /** 图片是否挂在节点行内（图片节点）而非行下方。 */
  private imagesInline = false;

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

    this.bulletEl = div('bullet');
    this.bulletEl.setAttribute('aria-hidden', 'true');

    this.textEl = div('text');
    this.textEl.contentEditable = 'plaintext-only';
    this.textEl.spellcheck = false;
    this.textEl.dataset.field = 'text';
    this.textEl.setAttribute('role', 'textbox');
    this.textEl.setAttribute('aria-multiline', 'false');

    this.row.append(this.toggleEl, this.bulletEl, this.textEl);
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
    this.toggleEl.setAttribute('aria-label', opts.folded ? t('toggle.expand') : t('toggle.collapse'));
    this.el.classList.toggle('folded', opts.folded);

    if (!opts.skipText) this.syncText(node);

    this.syncMirrorState(opts);

    this.row.classList.toggle('checked', node.checked === true);
    this.row.classList.toggle('task', node.checked !== null);
    this.row.classList.toggle('mirror', node.mirror !== null);
    // 正文只有图片语法 → 不显示源码，只留图（CSS 在未聚焦时把 .text 透明掉，见 styles.css）
    this.row.classList.toggle('image-only', node.mirror === null && isImageOnly(node.text));
    // 有序项：bullet 位显示编号（`12.`），普通节点为空（由 CSS 画圆点）
    this.row.classList.toggle('ordered', node.ordered != null);
    const bulletText = node.ordered ? node.ordered.num + node.ordered.delim : '';
    if (this.bulletEl.textContent !== bulletText) this.bulletEl.textContent = bulletText;
    this.el.classList.toggle('has-children', node.children.length > 0);
    this.toggleEl.style.visibility = node.children.length > 0 ? 'visible' : 'hidden';

    this.syncBadge(node);
    this.syncNote(node, opts);
    this.syncImages(node);
  }

  /**
   * 节点正文里的图片渲染成预览（源码 `![[x]]` / `![](x)` 仍留在可编辑正文里，可继续编辑）。
   * 纯渲染，不改数据。镜像行不参与。图片集合未变时跳过重建，避免重复加载闪烁。
   *
   * **图片节点**（正文只有图片语法）把预览挂进 `.node-row` 里、排在隐形正文之前：
   * 图片本身就是这一行的内容，不该在它上面多出一条空行（实机反馈）。其余节点仍挂在行
   * 下方（正文有字，图是附加内容）。
   */
  private syncImages(node: OutlineNode): void {
    const images: ParsedImage[] = node.mirror !== null ? [] : parseImages(node.text);
    const inline = this.row.classList.contains('image-only');
    const key = images.map((i) => i.src).join('\n');
    const unchanged =
      key === this.imagesKey &&
      inline === this.imagesInline &&
      (images.length === 0) === (this.imagesEl === null);
    if (unchanged) return;
    this.imagesKey = key;
    this.imagesInline = inline;

    if (images.length === 0) {
      this.imagesEl?.remove();
      this.imagesEl = null;
      return;
    }
    if (this.imagesEl === null) this.imagesEl = div('node-images');
    const parent = inline ? this.row : this.el;
    if (this.imagesEl.parentElement !== parent) {
      if (inline) this.row.insertBefore(this.imagesEl, this.textEl);
      else this.el.insertBefore(this.imagesEl, this.childrenEl);
    }
    this.imagesEl.replaceChildren(...images.map((im) => imageEl(im)));
  }

  /**
   * 镜像状态：展开出来的镜像行可编辑（编辑落到原节点）；断链与循环引用是只读占位，
   * 保留原文 `![[#^id]]`，绝不静默删除、不丢数据（见 docs/06）。
   */
  /**
   * 正文文本。未聚焦且含行内记号 → 显示态（见 inline.ts）；否则纯文本快路径。
   * 显示态下 textContent ≠ 源文本（记号被隐藏），所以判等必须走 dataset.src，
   * 否则每次 patch 都会「不相等 → 重建」，直接吃掉 refresh 的 50ms 红线余量（见 07）。
   */
  private syncText(node: OutlineNode): void {
    const focused = document.activeElement === this.textEl;
    // 镜像行的正文是 ![[#^id]]，归镜像层处理，不做行内渲染
    const wantRendered = !focused && node.mirror === null && hasInlineMarkup(node.text);

    if (wantRendered) {
      if (this.textEl.dataset.src !== node.text) renderInline(this.textEl, node.text);
      return;
    }
    if (isRendered(this.textEl)) toSourceMode(this.textEl);
    if (this.textEl.textContent !== node.text) this.textEl.textContent = node.text;
  }

  private syncMirrorState(opts: UpdateOptions): void {
    const state = opts.mirrorState ?? 'none';
    this.el.classList.toggle('mirror-view', state === 'mirror');
    this.el.classList.toggle('mirror-broken', state === 'broken');
    this.el.classList.toggle('mirror-cycle', state === 'cycle');

    const readOnly = state === 'broken' || state === 'cycle';
    this.textEl.contentEditable = readOnly ? 'false' : 'plaintext-only';

    const hint = readOnly ? (state === 'broken' ? t('mirror.broken') : t('mirror.cycle')) : null;
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
      this.row.title = t('mirror.ignoredChildren');
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

  /**
   * note 整体是围栏代码块时，渲染成代码块 UI（语言徽标 + textarea），而不是纯文本备注。
   *
   * 这就是「节点下面挂代码块」——文件里是缩进在该列表项内容列下的围栏块，parser 早就
   * 把它解析成该节点的 note（见 docs/03），Obsidian / Logseq 也照常渲染。所以本功能
   * 不需要新 op、不改数据模型：编辑走既有的 setNote。
   */
  private syncNoteCode(fence: CodeFence, node: OutlineNode): void {
    // 与普通 note 二选一：切换过来时把旧的备注 div 摘掉（正在编辑它时留到下一帧）
    if (this.noteEl !== null && this.noteEl !== document.activeElement) {
      this.noteEl.remove();
      this.noteEl = null;
    }
    if (this.noteCodeEl === null) this.noteCodeEl = div('node-code raw-block code-block');

    // 正文为空 = 这个节点就是一个代码块：把块挂进行内，别在它上面留一条空 bullet 行
    // （同图片节点，见 syncImages）。正文有字时仍挂在行下方——那时代码是附加内容。
    const inline = node.text === '';
    this.row.classList.toggle('code-only', inline);
    const parent = inline ? this.row : this.el;
    if (this.noteCodeEl.parentElement !== parent || inline !== this.noteCodeInline) {
      // 行内时挂在正文**之后**：正文为空（宽度 0）看不出差别，但一旦正文获得焦点，
      // 它会占住 bullet 右边这一行、代码块顺势折到下一行 —— 像个标题栏。
      // 反过来（代码块在前）焦点一来就在代码块下方冒出一条空输入框，很像 bug（实机反馈）。
      if (inline) this.row.append(this.noteCodeEl);
      else this.el.insertBefore(this.noteCodeEl, this.childrenEl);
      this.noteCodeInline = inline;
    }

    // 正在编辑本块时绝不重建 textarea，否则打断输入（同 updateRawBlockView）
    if (this.noteCodeEl.contains(document.activeElement)) return;
    renderFence(this.noteCodeEl, fence, 'noteCode');
  }

  private syncNote(node: OutlineNode, opts: UpdateOptions): void {
    const fence = node.note === null ? null : parseFence(node.note.split('\n'));
    if (fence !== null) {
      this.syncNoteCode(fence, node);
      return;
    }
    this.row.classList.remove('code-only');
    // note 被删掉（空块 Backspace）时无条件摘除：此刻焦点正在这个 textarea 里，
    // 若照搬「正在编辑就不动」的守卫，代码块会赖着不走。
    if (
      this.noteCodeEl !== null &&
      (node.note === null || !this.noteCodeEl.contains(document.activeElement))
    ) {
      this.noteCodeEl.remove();
      this.noteCodeEl = null;
    }
    if (node.note === null) {
      // 只在 note 本身没被聚焦时移除：skipText 会因「同节点正文获得焦点」而误挡删除，
      // 但删掉一个空 note 不会动到正在编辑的正文，只需避免把「正在编辑的 note」抽走。
      if (this.noteEl !== null && this.noteEl !== document.activeElement) {
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
  const el = document.createElement('div');
  el.className = 'raw-block';
  updateRawBlockView(el, lines);
  return el;
}

export function updateRawBlockView(el: HTMLElement, lines: string[]): void {
  // 围栏代码块：隐藏 ``` 围栏、显示语言标签、代码样式（只读，原文仍在文件里）。
  // parser 已把每个围栏块切成独立 RawBlock，这里首行是 fence 即整块为代码。
  const code = parseFence(lines);
  if (code) {
    el.classList.add('code-block');
    el.classList.remove('blank', 'image-block');
    // 正在编辑本块时绝不重建 textarea，否则打断输入（同 node 的 skipText 思路）
    if (el.contains(document.activeElement)) return;
    // 保留原始首尾围栏行，编辑时只换中间正文（见 04 setRawBlock）
    renderFence(el, code, 'code');
    return;
  }
  el.classList.remove('code-block');
  delete el.dataset.codeSig;
  delete el.dataset.codeOpen;
  delete el.dataset.codeClose;

  // 独立成行的图片：渲染成 <img>（只读，原文仍在文件里）
  const image = lines.length === 1 ? wholeLineImage(lines[0]) : null;
  if (image) {
    el.classList.add('image-block');
    el.classList.remove('blank');
    const existing = el.querySelector('img');
    if (existing) {
      if (existing.getAttribute('src') !== image.src) existing.src = image.src;
      existing.alt = image.alt;
    } else {
      el.replaceChildren(imageEl(image));
    }
    return;
  }

  el.classList.remove('image-block');
  const text = lines.join('\n');
  // 有元素子节点（上一轮的 <img>）时强制重置，避免残留
  if (el.firstElementChild || el.textContent !== text) el.textContent = text;
  // 仅含空行的 RawBlock 渲染成细分隔，让被空行拆开的列表在视觉上连续（纯样式，不改模型）
  el.classList.toggle('blank', lines.every((line) => line.trim() === ''));
}

function imageEl(image: ParsedImage): HTMLImageElement {
  const img = document.createElement('img');
  img.className = 'node-image';
  img.src = image.src;
  img.alt = image.alt;
  img.loading = 'lazy';
  return img;
}

function div(className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}
