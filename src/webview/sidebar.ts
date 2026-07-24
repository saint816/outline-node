// 内嵌左侧导航栏（Workflowy 风格）：顶层节点导航 + 星标书签，点击即 zoom。
// 纯渲染，不改数据、不落用户文件（星标存 workspaceState，见 store.flushBookmarks）。
// 列表封顶 MAX_ITEMS：真实大纲顶层极少超此数，同时护住 refresh patch 的性能红线（见 docs/07）。

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

    if (model.starred.length > 0) {
      parts.push(section(t('sidebar.starred')));
      for (const node of model.starred.slice(0, MAX_ITEMS)) parts.push(this.item(node, model));
    }

    parts.push(section(t('sidebar.outline')));
    if (model.topLevel.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sidebar-empty';
      empty.textContent = t('sidebar.empty');
      parts.push(empty);
    } else {
      for (const node of model.topLevel.slice(0, MAX_ITEMS)) parts.push(this.item(node, model));
    }

    this.body.replaceChildren(...parts);
  }

  private homeItem(active: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'sidebar-item sidebar-home' + (active ? ' active' : '');
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'sidebar-label';
    label.textContent = t('breadcrumb.home');
    label.addEventListener('click', () => this.cb.onNavigate(null));
    row.append(label);
    return row;
  }

  private item(node: OutlineNode, model: SidebarModel): HTMLElement {
    const row = document.createElement('div');
    row.className = 'sidebar-item' + (node.id === model.currentZoomId ? ' active' : '');

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

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'sidebar-label';
    const text = node.text.trim() === '' ? t('node.empty') : node.text;
    label.textContent = text;
    label.title = text;
    label.addEventListener('click', () => this.cb.onNavigate(node.id));

    row.append(star, label);
    return row;
  }
}

function section(title: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sidebar-section';
  el.textContent = title;
  return el;
}
