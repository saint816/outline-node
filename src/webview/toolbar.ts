// 顶部工具条：zoom 前进/后退、隐藏已完成、帮助。搜索框元素由 main 传入嵌进来。
// 纯 UI，不改数据。

import { t } from './i18n.js';

export interface ToolbarCallbacks {
  onBack(): void;
  onForward(): void;
  onToggleHideCompleted(): void;
  onHelp(): void;
}

export interface ToolbarState {
  canBack: boolean;
  canForward: boolean;
  hideCompleted: boolean;
}

export class Toolbar {
  readonly el: HTMLElement;
  private readonly backBtn: HTMLButtonElement;
  private readonly forwardBtn: HTMLButtonElement;
  private readonly hideBtn: HTMLButtonElement;

  constructor(cb: ToolbarCallbacks, searchEl: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'topbar';

    this.backBtn = iconButton('‹', t('toolbar.back'), () => cb.onBack());
    this.forwardBtn = iconButton('›', t('toolbar.forward'), () => cb.onForward());
    this.hideBtn = iconButton('✓', t('toolbar.hideCompleted'), () => cb.onToggleHideCompleted());
    const helpBtn = iconButton('?', t('toolbar.help'), () => cb.onHelp());

    const nav = document.createElement('div');
    nav.className = 'topbar-nav';
    nav.append(this.backBtn, this.forwardBtn);

    const actions = document.createElement('div');
    actions.className = 'topbar-actions';
    actions.append(this.hideBtn, helpBtn);

    this.el.append(nav, searchEl, actions);
  }

  update(state: ToolbarState): void {
    this.backBtn.disabled = !state.canBack;
    this.forwardBtn.disabled = !state.canForward;
    this.hideBtn.classList.toggle('on', state.hideCompleted);
    this.hideBtn.setAttribute('aria-pressed', String(state.hideCompleted));
    this.hideBtn.setAttribute(
      'aria-label',
      state.hideCompleted ? t('toolbar.showCompleted') : t('toolbar.hideCompleted'),
    );
  }
}

function iconButton(glyph: string, label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'topbar-btn';
  btn.textContent = glyph;
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.addEventListener('click', onClick);
  return btn;
}
