// 快捷键帮助浮层（? 开关）。静态内容，标签走 i18n，键位保持字面。

import { t, type MessageKey } from './i18n.js';

const SHORTCUTS: { keys: string; labelKey: MessageKey }[] = [
  { keys: 'Enter', labelKey: 'help.split' },
  { keys: 'Shift+Enter', labelKey: 'help.note' },
  { keys: 'Tab / Shift+Tab', labelKey: 'help.indent' },
  { keys: 'Backspace', labelKey: 'help.merge' },
  { keys: 'Alt+↑ / Alt+↓', labelKey: 'help.move' },
  { keys: 'Cmd/Ctrl+Enter', labelKey: 'help.toggleChecked' },
  { keys: 'Alt+→ / Alt+←', labelKey: 'help.zoom' },
  { keys: 'Cmd/Ctrl+.', labelKey: 'help.fold' },
  { keys: '↑ / ↓', labelKey: 'help.moveCaret' },
  { keys: 'Cmd/Ctrl+Z / Shift+Z', labelKey: 'help.undo' },
  { keys: 'Cmd/Ctrl+F', labelKey: 'help.search' },
  { keys: 'Cmd/Ctrl+O', labelKey: 'help.hideCompleted' },
  { keys: '?', labelKey: 'help.help' },
];

export class HelpOverlay {
  private el: HTMLElement | null = null;

  isOpen(): boolean {
    return this.el !== null;
  }

  toggle(): void {
    if (this.el) this.close();
    else this.open();
  }

  close(): void {
    this.el?.remove();
    this.el = null;
  }

  private open(): void {
    const overlay = document.createElement('div');
    overlay.className = 'help-overlay';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });

    const panel = document.createElement('div');
    panel.className = 'help-panel';

    const title = document.createElement('div');
    title.className = 'help-title';
    title.textContent = t('help.title');

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'help-close';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', t('help.close'));
    closeBtn.addEventListener('click', () => this.close());

    const header = document.createElement('div');
    header.className = 'help-header';
    header.append(title, closeBtn);

    const list = document.createElement('dl');
    list.className = 'help-list';
    for (const s of SHORTCUTS) {
      const dt = document.createElement('dt');
      dt.textContent = s.keys;
      const dd = document.createElement('dd');
      dd.textContent = t(s.labelKey);
      list.append(dt, dd);
    }

    panel.append(header, list);
    overlay.append(panel);
    document.body.append(overlay);
    this.el = overlay;
  }
}
