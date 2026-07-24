// 内嵌左侧导航栏（Workflowy 风格）：可展开/折叠的大纲树 + 星标书签，点文字即 zoom。
// 纯渲染，不改数据、不落用户文件。侧栏的展开状态独立于主编辑区的折叠——存 webview 内存，
// 在侧栏展开不会折叠正文。渲染项封顶 MAX_ITEMS，护住 refresh patch 的性能红线（见 docs/07）。

import type { OutlineNode } from '../core/model.js';
import { t } from './i18n.js';

export interface SidebarCallbacks {
  onNavigate(id: string | null): void;
  onToggleStar(id: string): void;
  onToggleCollapse(): void;
}

export interface SidebarModel {
  topLevel: readonly OutlineNode[];
  starred: readonly OutlineNode[];
  currentZoomId: string | null;
  isStarred(id: string): boolean;
  collapsed: boolean;
}

const MAX_ITEMS = 200;

export class SidebarView {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly collapseBtn: HTMLButtonElement;
  /** 侧栏树里被展开的节点 id（独立于主编辑区折叠；仅存内存）。 */
  private readonly expanded = new Set<string>();
  private model: SidebarModel | null = null;

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

    this.el.append(this.collapseBtn, this.body);
  }

  update(model: SidebarModel): void {
    this.model = model;
    this.render();
  }

  private render(): void {
    const model = this.model;
    if (model === null) return;

    this.el.classList.toggle('collapsed', model.collapsed);
    this.collapseBtn.textContent = model.collapsed ? '›' : '‹';
    this.collapseBtn.setAttribute(
      'aria-label',
      model.collapsed ? t('sidebar.expandPanel') : t('sidebar.collapsePanel'),
    );
    if (model.collapsed) {
      this.body.replaceChildren();
      return;
    }

    const parts: HTMLElement[] = [this.homeItem(model.currentZoomId === null)];
    const counter = { n: 0 };

    if (model.starred.length > 0) {
      parts.push(section(t('sidebar.starred')));
      // 星标区扁平（书签就是导航目标，不展开）
      for (const node of model.starred) {
        if (counter.n >= MAX_ITEMS) break;
        counter.n++;
        parts.push(this.item(node, 0, false));
      }
    }

    parts.push(section(t('sidebar.outline')));
    if (model.topLevel.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sidebar-empty';
      empty.textContent = t('sidebar.empty');
      parts.push(empty);
    } else {
      this.renderTree(model.topLevel, parts, 0, counter);
    }

    this.body.replaceChildren(...parts);
  }

  /** 大纲区：递归渲染可展开树，只在展开的节点下挂子节点。 */
  private renderTree(
    nodes: readonly OutlineNode[],
    parts: HTMLElement[],
    depth: number,
    counter: { n: number },
  ): void {
    for (const node of nodes) {
      if (counter.n >= MAX_ITEMS) return;
      counter.n++;
      parts.push(this.item(node, depth, true));
      if (node.children.length > 0 && this.expanded.has(node.id)) {
        this.renderTree(node.children, parts, depth + 1, counter);
      }
    }
  }

  private toggleExpand(id: string): void {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    this.render();
  }

  private homeItem(active: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'sidebar-item sidebar-home' + (active ? ' active' : '');
    row.append(spacer());
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'sidebar-label';
    label.textContent = t('breadcrumb.home');
    label.addEventListener('click', () => this.cb.onNavigate(null));
    row.append(label);
    return row;
  }

  private item(node: OutlineNode, depth: number, tree: boolean): HTMLElement {
    const model = this.model!;
    const row = document.createElement('div');
    row.className = 'sidebar-item' + (node.id === model.currentZoomId ? ' active' : '');
    row.style.setProperty('--depth', String(depth));

    // 展开/折叠三角（仅大纲树、且有子节点时）
    if (tree && node.children.length > 0) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'sidebar-toggle';
      const expanded = this.expanded.has(node.id);
      toggle.textContent = expanded ? '▾' : '▸';
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.setAttribute('aria-label', expanded ? t('sidebar.collapseNode') : t('sidebar.expandNode'));
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleExpand(node.id);
      });
      row.append(toggle);
    } else {
      row.append(spacer());
    }

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'sidebar-label';
    const text = node.text.trim() === '' ? t('node.empty') : node.text;
    label.textContent = text;
    label.title = text;
    label.addEventListener('click', () => this.cb.onNavigate(node.id));
    row.append(label);

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
}

function section(title: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sidebar-section';
  el.textContent = title;
  return el;
}

function spacer(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'sidebar-toggle spacer';
  el.setAttribute('aria-hidden', 'true');
  return el;
}
