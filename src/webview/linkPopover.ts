// 浮动链接编辑框：保存选区由调用方负责，本组件只处理双输入与键盘/关闭行为。

import { t } from './i18n.js';

export interface LinkPopoverValue {
  title: string;
  url: string;
}

export class LinkPopover {
  private el: HTMLElement | null = null;
  private dismiss: ((event: PointerEvent) => void) | null = null;

  open(
    anchor: DOMRect,
    initial: LinkPopoverValue,
    onSubmit: (value: LinkPopoverValue) => void,
    onCancel: () => void,
  ): void {
    this.close();
    const box = document.createElement('form');
    box.className = 'link-popover';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', t('format.linkDialog'));

    const title = input(t('format.linkTitle'), initial.title);
    const url = input(t('format.linkUrl'), initial.url);
    url.required = true;
    const actions = document.createElement('div');
    actions.className = 'link-popover-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = t('format.cancel');
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'link-popover-save';
    save.textContent = t('format.saveLink');
    actions.append(cancel, save);
    box.append(title, url, actions);
    document.body.append(box);
    this.el = box;

    const { width, height } = box.getBoundingClientRect();
    box.style.left = `${Math.max(4, Math.min(window.innerWidth - width - 4, anchor.left))}px`;
    const below = anchor.bottom + 6;
    box.style.top = `${below + height > window.innerHeight ? Math.max(4, anchor.top - height - 6) : below}px`;

    const finish = (submit: boolean): void => {
      if (this.el !== box) return;
      const value = { title: title.value, url: url.value.trim() };
      if (submit && value.url === '') {
        url.reportValidity();
        return;
      }
      this.close();
      if (submit) onSubmit(value);
      else onCancel();
    };
    box.addEventListener('submit', (event) => {
      event.preventDefault();
      finish(true);
    });
    cancel.addEventListener('click', () => finish(false));
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    this.dismiss = (event: PointerEvent): void => {
      if (!box.contains(event.target as Node)) finish(false);
    };
    document.addEventListener('pointerdown', this.dismiss, true);
    url.focus();
    url.select();
  }

  close(): void {
    if (this.dismiss) document.removeEventListener('pointerdown', this.dismiss, true);
    this.dismiss = null;
    this.el?.remove();
    this.el = null;
  }
}

function input(placeholder: string, value: string): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'text';
  el.className = 'link-popover-input';
  el.placeholder = placeholder;
  el.setAttribute('aria-label', placeholder);
  el.value = value;
  return el;
}
