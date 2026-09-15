// zoom 面包屑（规格见 docs/05）。zoom 状态本身存在 store，这里只负责路径条的 DOM。

import type { OutlineNode } from '../core/model.js';
import { t } from './i18n.js';

export class Breadcrumb {
  readonly el: HTMLElement;

  constructor(private readonly onNavigate: (id: string | null) => void) {
    this.el = document.createElement('nav');
    this.el.className = 'breadcrumb';
    this.el.setAttribute('aria-label', t('breadcrumb.ariaLabel'));
    this.el.hidden = true;
  }

  /** trail = 根 → … → 当前 zoom 节点；空数组表示未 zoom。 */
  update(trail: readonly OutlineNode[]): void {
    if (trail.length === 0) {
      this.el.hidden = true;
      this.el.replaceChildren();
      return;
    }

    this.el.hidden = false;
    const parts: HTMLElement[] = [this.crumb(t('breadcrumb.home'), null)];
    // 最后一级是当前 zoom 根，不可点
    for (let i = 0; i < trail.length; i++) {
      parts.push(separator());
      const node = trail[i];
      const label = node.text.trim() === '***' ? t('divider.label') : node.text.trim() === '' ? t('node.empty') : node.text;
      parts.push(i === trail.length - 1 ? current(label) : this.crumb(label, node.id));
    }
    this.el.replaceChildren(...parts);
  }

  private crumb(label: string, id: string | null): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'crumb';
    button.textContent = label;
    button.addEventListener('click', () => this.onNavigate(id));
    return button;
  }
}

function current(label: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'crumb current';
  span.textContent = label;
  return span;
}

function separator(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'crumb-sep';
  span.textContent = '›';
  span.setAttribute('aria-hidden', 'true');
  return span;
}
