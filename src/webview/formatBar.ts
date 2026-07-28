// 选中文字后浮出的排版小工具条（加粗 / 高亮 / 行内代码 / 链接）。
//
// 为什么是工具条而不是快捷键：webview 的按键会被转发给工作台做快捷键解析，
// `preventDefault` 拦不住 VS Code 自己的绑定（`Cmd+B` = 切换侧边栏），
// 本项目已在 `Cmd+O`、`Cmd+Alt+O` 上实机栽过两次。工具条完全绕开这件事。
// 快捷键仍然提供，但只挑 VS Code 没占的组合，见 keymap 的 isFormatKey。
//
// 纯 UI：只调 store.setNodeText + 重设选区，不新增 op、不改协议。

import { t } from './i18n.js';
import type { Marker } from './format.js';

export interface FormatBarCallbacks {
  onMarker(marker: Marker): void;
  onLink(): void;
}

interface Item {
  key: string;
  label: string;
  title: () => string;
  run(cb: FormatBarCallbacks): void;
}

const ITEMS: Item[] = [
  { key: 'bold', label: 'B', title: () => t('format.bold'), run: (cb) => cb.onMarker('**') },
  { key: 'mark', label: 'H', title: () => t('format.highlight'), run: (cb) => cb.onMarker('==') },
  { key: 'code', label: '</>', title: () => t('format.code'), run: (cb) => cb.onMarker('`') },
  { key: 'link', label: '🔗', title: () => t('format.link'), run: (cb) => cb.onLink() },
];

export class FormatBar {
  readonly el: HTMLElement;
  private visible = false;

  constructor(private readonly cb: FormatBarCallbacks) {
    this.el = document.createElement('div');
    this.el.className = 'format-bar';
    this.el.hidden = true;
    this.el.setAttribute('role', 'toolbar');
    this.el.setAttribute('aria-label', t('format.ariaLabel'));

    for (const item of ITEMS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `format-btn format-${item.key}`;
      btn.textContent = item.label;
      btn.title = item.title();
      btn.setAttribute('aria-label', item.title());
      // mousedown 一律 preventDefault：否则按下的瞬间选区就没了，等到 click 已经无从下手
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        item.run(this.cb);
      });
      this.el.append(btn);
    }
    document.body.append(this.el);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** 贴着选区上沿显示（超出视口上缘就翻到下沿）。 */
  showAt(rect: DOMRect): void {
    this.el.hidden = false;
    this.visible = true;
    const { width, height } = this.el.getBoundingClientRect();
    const left = Math.max(4, Math.min(window.innerWidth - width - 4, rect.left + rect.width / 2 - width / 2));
    const above = rect.top - height - 6;
    this.el.style.left = `${left}px`;
    this.el.style.top = `${above < 4 ? rect.bottom + 6 : above}px`;
  }

  hide(): void {
    if (!this.visible) return;
    this.el.hidden = true;
    this.visible = false;
  }
}
