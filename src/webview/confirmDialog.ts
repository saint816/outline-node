// 删除子树前的二次确认。纯 Webview UI，不写文件、不碰协议。

import { t } from './i18n.js';

export function confirmSubtreeDelete(rootCount: number, descendantCount: number): Promise<boolean> {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'delete-confirm-title');
    dialog.setAttribute('aria-describedby', 'delete-confirm-message');

    const title = document.createElement('h2');
    title.id = 'delete-confirm-title';
    title.className = 'confirm-title';
    title.textContent = t('deleteConfirm.title');

    const message = document.createElement('p');
    message.id = 'delete-confirm-message';
    message.className = 'confirm-message';
    message.textContent = t('deleteConfirm.message')
      .replace('{roots}', String(rootCount))
      .replace('{descendants}', String(descendantCount));

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'confirm-cancel';
    cancel.textContent = t('deleteConfirm.cancel');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'confirm-delete';
    remove.textContent = t('deleteConfirm.delete');
    actions.append(cancel, remove);
    dialog.append(title, message, actions);
    overlay.append(dialog);
    document.body.append(overlay);

    let done = false;
    const finish = (answer: boolean): void => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      if (!answer) previousFocus?.focus();
      resolve(answer);
    };
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
      if (event.key === 'Tab') {
        const next = document.activeElement === cancel && !event.shiftKey ? remove : cancel;
        event.preventDefault();
        next.focus();
      }
    };

    cancel.addEventListener('click', () => finish(false));
    remove.addEventListener('click', () => finish(true));
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) finish(false);
    });
    document.addEventListener('keydown', onKeydown, true);
    cancel.focus();
  });
}
