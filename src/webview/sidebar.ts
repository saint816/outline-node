// 内嵌左侧导航栏：可展开/折叠的大纲树 + 星标书签，点文字即 zoom，
// 拖拽整行即移动节点（复用主编辑区的 move op 与落点数学 resolvePlacement）。
// 纯渲染 + 结构 op，不改数据格式、不落 UI 态到用户文件。侧栏的展开状态独立于主编辑区折叠——
// 存 webview 内存，在侧栏展开不会折叠正文。渲染项封顶 MAX_ITEMS，护住 refresh patch 的性能红线。

import type { OutlineNode } from '../core/model.js';
import { cssEscape, resolvePlacement } from './dnd.js';
import { t } from './i18n.js';

export interface SidebarCallbacks {
  onNavigate(id: string | null, section: SidebarNavSection): void;
  onToggleStar(id: string): void;
  onToggleCollapse(): void;
  /** 拖拽落定：把 id 移到 parentId 下的 index 处（index 按「摘除前」坐标，见 core/ops move）。 */
  onMove(id: string, parentId: string | null, index: number): void;
  /** 分区折叠状态变化（纯 UI 态，交给 ViewState 持久化）。 */
  onSectionsChanged(collapsedKeys: readonly string[]): void;
}

export interface SidebarModel {
  topLevel: readonly OutlineNode[];
  starred: readonly OutlineNode[];
  currentZoomId: string | null;
  /** 同一节点可同时出现在 Starred 与 Home 树中，只高亮实际进入它的那一份。 */
  currentSection: SidebarNavSection;
  isStarred(id: string): boolean;
  collapsed: boolean;
}

export type SidebarNavSection = 'starred' | 'outline';

/** 大纲树里一行的位置信息（拖拽落点计算用）。结构上兼容 dnd 的 PlacementRow。 */
interface SidebarRow {
  node: OutlineNode;
  parentId: string | null;
  index: number;
  depth: number;
}

const MAX_ITEMS = 200;
const DRAG_THRESHOLD_PX = 4;
// 与 styles.css 的 .sidebar-item padding-left: calc(BASE + depth * STEP) 保持一致
const INDENT_BASE_PX = 17;
const INDENT_STEP_PX = 13;

export class SidebarView {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly collapseBtn: HTMLButtonElement;
  private readonly indicator: HTMLElement;
  /** 侧栏树里被展开的节点 id（独立于主编辑区折叠；仅存内存）。 */
  private readonly expanded = new Set<string>();
  /** 被折叠的分区键（'starred' / 'outline'）；随 ViewState 持久化，见 main.ts。 */
  private collapsedSections = new Set<string>();
  private model: SidebarModel | null = null;
  /** 当前渲染出的大纲树行（按渲染顺序），拖拽落点计算用。 */
  private rows: SidebarRow[] = [];
  /** 当前渲染出的 id → label 元素（同一 id 可同时在 Starred 与 OUTLINE 出现）。syncText 热更新用。 */
  private readonly labels = new Map<string, HTMLElement[]>();
  private drag: {
    id: string;
    startX: number;
    startY: number;
    active: boolean;
    target: { parentId: string | null; index: number } | null;
  } | null = null;
  /** 拖拽结束后吞掉紧随的一次 click，避免误触发导航/展开。 */
  private suppressClick = false;

  constructor(private readonly cb: SidebarCallbacks) {
    this.el = document.createElement('aside');
    this.el.className = 'sidebar';
    this.el.setAttribute('aria-label', t('sidebar.ariaLabel'));

    this.collapseBtn = document.createElement('button');
    this.collapseBtn.type = 'button';
    this.collapseBtn.className = 'sidebar-collapse';
    this.collapseBtn.addEventListener('click', () => this.cb.onToggleCollapse());

    this.body = document.createElement('div');
    this.body.className = 'sidebar-body';

    // 自己的类名，避免和主编辑区常驻/临时的 .drop-indicator 撞选择器
    this.indicator = document.createElement('div');
    this.indicator.className = 'sidebar-drop-indicator';
    this.indicator.hidden = true;

    this.el.append(this.collapseBtn, this.body);

    this.installDrag();
  }

  update(model: SidebarModel): void {
    this.model = model;
    this.render();
  }

  /**
   * 打字热路径：只改侧栏里这个节点 label 的文字，不整树重渲染。
   * store 的 setNodeText 刻意不 emit（护住击键红线，见 docs/07），侧栏靠这个跟上编辑。
   * 同名 label 可能出现多处（Starred + OUTLINE），全部更新。
   */
  syncText(id: string, text: string): void {
    const labels = this.labels.get(id);
    if (labels === undefined) return;
    const shown = text.trim() === '***' ? t('divider.label') : text.trim() === '' ? t('node.empty') : text;
    for (const label of labels) {
      label.textContent = shown;
      label.title = shown;
    }
  }

  private render(): void {
    const model = this.model;
    if (model === null) return;

    this.rows = [];
    this.labels.clear();
    this.el.classList.toggle('collapsed', model.collapsed);
    this.collapseBtn.textContent = model.collapsed ? '→' : '←';
    this.collapseBtn.setAttribute(
      'aria-label',
      model.collapsed ? t('sidebar.expandPanel') : t('sidebar.collapsePanel'),
    );
    if (model.collapsed) {
      this.body.replaceChildren();
      return;
    }

    const parts: HTMLElement[] = [];
    const counter = { n: 0 };

    if (model.starred.length > 0) {
      const open = !this.collapsedSections.has('starred');
      parts.push(this.section(t('sidebar.starred'), 'starred', open));
      // 星标区可展开成子树（书签可看结构，但不作为拖拽源/落点）
      if (open) this.renderStarred(model.starred, parts, 0, counter);
    }

    // 大纲区的标题就是 Home 本身（点它 = 回全文档），不再另起一行重复 Home
    const outlineOpen = !this.collapsedSections.has('outline');
    parts.push(this.homeItem(outlineOpen));
    if (!outlineOpen) {
      this.body.replaceChildren(...parts, this.indicator);
      return;
    }
    if (model.topLevel.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sidebar-empty';
      empty.textContent = t('sidebar.empty');
      parts.push(empty);
    } else {
      this.renderTree(model.topLevel, parts, 0, null, counter);
    }

    // 指示线随 body 一起重建：作为最后一个子元素常驻（默认 hidden）
    this.body.replaceChildren(...parts, this.indicator);
  }

  /** 大纲区：递归渲染可展开树，只在展开的节点下挂子节点；同时登记每行的位置信息。 */
  private renderTree(
    nodes: readonly OutlineNode[],
    parts: HTMLElement[],
    depth: number,
    parentId: string | null,
    counter: { n: number },
  ): void {
    for (let index = 0; index < nodes.length; index++) {
      if (counter.n >= MAX_ITEMS) return;
      const node = nodes[index];
      counter.n++;
      parts.push(this.item(node, depth, 'outline'));
      this.rows.push({ node, parentId, index, depth });
      if (node.children.length > 0 && this.expanded.has(node.id)) {
        this.renderTree(node.children, parts, depth + 1, node.id, counter);
      }
    }
  }

  /** 星标区：每个书签可展开成其子树（可看结构，但不作为拖拽源/落点，也不登记进 rows）。 */
  private renderStarred(
    nodes: readonly OutlineNode[],
    parts: HTMLElement[],
    depth: number,
    counter: { n: number },
  ): void {
    for (const node of nodes) {
      if (counter.n >= MAX_ITEMS) return;
      counter.n++;
      parts.push(this.item(node, depth, 'starred'));
      if (node.children.length > 0 && this.expanded.has(node.id)) {
        this.renderStarred(node.children, parts, depth + 1, counter);
      }
    }
  }

  /** 分区标题本身就是折叠开关：Starred 收起后不再和大纲重复列同一节点。 */
  private section(title: string, key: string, open: boolean): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'sidebar-section';
    el.dataset.section = key;
    el.setAttribute('aria-expanded', String(open));
    const caret = document.createElement('span');
    caret.className = 'sidebar-section-caret';
    caret.textContent = open ? '▾' : '▸';
    caret.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'sidebar-section-label';
    text.textContent = title;
    el.append(caret, text);
    el.addEventListener('click', () => this.toggleSection(key));
    return el;
  }

  private toggleSection(key: string): void {
    if (this.collapsedSections.has(key)) this.collapsedSections.delete(key);
    else this.collapsedSections.add(key);
    this.cb.onSectionsChanged([...this.collapsedSections]);
    this.render();
    this.refocus(`[data-section="${cssEscape(key)}"]`);
  }

  /** ViewState 恢复：外部灌入已折叠的分区键（渲染由随后的 update 负责）。 */
  restoreSections(keys: readonly string[]): void {
    this.collapsedSections = new Set(keys);
  }

  private toggleExpand(id: string, section: SidebarNavSection): void {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    this.render();
    this.refocus(
      `.sidebar-item[data-nav-section="${section}"][data-id="${cssEscape(id)}"] > .sidebar-toggle`,
    );
  }

  /** render() 整栏重建会把焦点甩到 body：把它送回刚点的那个开关，键盘操作才连得上。 */
  private refocus(selector: string): void {
    if (!this.body.contains(document.activeElement) && document.activeElement !== document.body) {
      return;
    }
    this.body.querySelector<HTMLElement>(selector)?.focus();
  }

  /** Home = 大纲区的标题行：三角折叠整区，文字导航回全文档。
      刻意不标 .active —— 它是常驻入口而非「当前位置」，常年高亮+粗体反而像误选中（实机反馈）。 */
  private homeItem(open: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'sidebar-item sidebar-home';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'sidebar-toggle';
    toggle.dataset.section = 'outline';
    toggle.textContent = open ? '▾' : '▸';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? t('sidebar.collapseNode') : t('sidebar.expandNode'));
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleSection('outline');
    });
    row.append(toggle);

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'sidebar-label';
    label.textContent = t('breadcrumb.home');
    label.addEventListener('click', () => this.cb.onNavigate(null, 'outline'));
    row.append(label);
    return row;
  }

  private item(node: OutlineNode, depth: number, section: SidebarNavSection): HTMLElement {
    const model = this.model!;
    const draggable = section === 'outline';
    const row = document.createElement('div');
    const active = node.id === model.currentZoomId && section === model.currentSection;
    row.className = 'sidebar-item' + (active ? ' active' : '');
    row.dataset.navSection = section;
    row.style.setProperty('--depth', String(depth));
    // 只有大纲树行可拖拽（星标书签不参与结构移动）；data-id 两区都挂，供 refocus 定位
    row.dataset.id = node.id;
    if (draggable) row.classList.add('sidebar-draggable');

    // 展开/折叠三角（大纲树与星标区都可展开；有子节点时显示）
    if (node.children.length > 0) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'sidebar-toggle';
      const expanded = this.expanded.has(node.id);
      toggle.textContent = expanded ? '▾' : '▸';
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.setAttribute('aria-label', expanded ? t('sidebar.collapseNode') : t('sidebar.expandNode'));
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleExpand(node.id, section);
      });
      row.append(toggle);
    } else {
      row.append(spacer());
    }

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'sidebar-label';
    const text = node.text.trim() === '***' ? t('divider.label') : node.text.trim() === '' ? t('node.empty') : node.text;
    label.textContent = text;
    label.title = text;
    label.addEventListener('click', () => this.cb.onNavigate(node.id, section));
    row.append(label);
    // 登记 label，供 syncText 打字热更新（同一 id 在 Starred + OUTLINE 各有一个）
    const bucket = this.labels.get(node.id);
    if (bucket) bucket.push(label);
    else this.labels.set(node.id, [label]);

    const starred = model.isStarred(node.id);
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'sidebar-star' + (starred ? ' on' : '');
    star.textContent = starred ? '★' : '☆';
    star.setAttribute('aria-label', starred ? t('sidebar.unstar') : t('sidebar.star'));
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cb.onToggleStar(node.id);
    });
    row.append(star);

    return row;
  }

  // ---------- 拖拽移动 ----------

  private installDrag(): void {
    this.body.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    // move/up 挂到 window：指针可能移出侧栏
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', () => this.onPointerUp());
    window.addEventListener('pointercancel', () => this.cancelDrag());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.drag?.active) {
        e.preventDefault();
        this.cancelDrag();
      }
    });
    // 捕获阶段吞掉拖拽后的那次 click（早于 label/toggle 的冒泡处理）
    this.body.addEventListener(
      'click',
      (e) => {
        if (this.suppressClick) {
          e.preventDefault();
          e.stopPropagation();
          this.suppressClick = false;
        }
      },
      true,
    );
  }

  private onPointerDown(e: PointerEvent): void {
    this.suppressClick = false;
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    // 星标是独立动作，不作为拖拽起点
    if (!target || target.closest('.sidebar-star')) return;
    const rowEl = target.closest<HTMLElement>('.sidebar-item.sidebar-draggable');
    const id = rowEl?.dataset.id;
    if (!id) return;
    this.drag = { id, startX: e.clientX, startY: e.clientY, active: false, target: null };
  }

  private onPointerMove(e: PointerEvent): void {
    const drag = this.drag;
    if (drag === null) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
      drag.active = true;
      this.rowElement(drag.id)?.classList.add('dragging');
    }
    e.preventDefault();
    const drop = this.computeDrop(drag.id, e.clientX, e.clientY);
    drag.target = drop ? { parentId: drop.parentId, index: drop.index } : null;
    if (drop) {
      this.indicator.hidden = false;
      this.indicator.style.top = `${drop.top}px`;
      this.indicator.style.left = `${drop.left}px`;
    } else {
      this.indicator.hidden = true;
    }
  }

  private onPointerUp(): void {
    const drag = this.drag;
    if (drag === null) return;
    if (drag.active) {
      this.rowElement(drag.id)?.classList.remove('dragging');
      if (drag.target) {
        this.suppressClick = true;
        this.cb.onMove(drag.id, drag.target.parentId, drag.target.index);
      }
    }
    this.indicator.hidden = true;
    this.drag = null;
  }

  private cancelDrag(): void {
    if (this.drag?.active) this.rowElement(this.drag.id)?.classList.remove('dragging');
    this.indicator.hidden = true;
    this.drag = null;
  }

  private rowElement(id: string): HTMLElement | null {
    return this.body.querySelector<HTMLElement>(
      `.sidebar-item.sidebar-draggable[data-id="${cssEscape(id)}"]`,
    );
  }

  /** 指针位置 → 落点。落点非法（跨 block / 成环）由 move op 兜底为 no-op，这里不重复校验。 */
  private computeDrop(
    dragId: string,
    x: number,
    y: number,
  ): { parentId: string | null; index: number; top: number; left: number } | null {
    const dragged = this.rows.find((r) => r.node.id === dragId);
    if (!dragged) return null;
    const excluded = subtreeIds(dragged.node);

    const entries = this.rows
      .filter((r) => !excluded.has(r.node.id))
      .map((r) => ({ row: r, el: this.rowElement(r.node.id) }))
      .filter((e): e is { row: SidebarRow; el: HTMLElement } => e.el !== null)
      .map((e) => ({ ...e, rect: e.el.getBoundingClientRect() }));
    if (entries.length === 0) return null;

    let afterIndex = -1;
    for (let i = 0; i < entries.length; i++) {
      const rect = entries[i].rect;
      if (y >= rect.top + rect.height / 2) afterIndex = i;
    }
    const after = afterIndex >= 0 ? entries[afterIndex] : null;
    const next = entries[afterIndex + 1] ?? null;

    const maxDepth = after ? after.row.depth + 1 : 0;
    const minDepth = next ? next.row.depth : 0;
    const bodyRect = this.body.getBoundingClientRect();
    const wanted = Math.round((x - bodyRect.left - INDENT_BASE_PX) / INDENT_STEP_PX);
    const depth = Math.max(
      Math.min(minDepth, maxDepth),
      Math.min(maxDepth, Math.max(minDepth, wanted)),
    );

    const placement = resolvePlacement(
      entries.map((e) => e.row),
      after?.row ?? null,
      depth,
    );
    if (!placement) return null;

    const gapBottom = after ? after.rect.bottom : entries[0].rect.top;
    return {
      ...placement,
      top: gapBottom - bodyRect.top,
      left: INDENT_BASE_PX + depth * INDENT_STEP_PX,
    };
  }
}

function spacer(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'sidebar-toggle spacer';
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/** 一个节点连同全部后代的 id（拖拽时不能落进自己的子树）。 */
function subtreeIds(node: OutlineNode): Set<string> {
  const out = new Set<string>();
  const walk = (n: OutlineNode): void => {
    out.add(n.id);
    for (const child of n.children) walk(child);
  };
  walk(node);
  return out;
}
