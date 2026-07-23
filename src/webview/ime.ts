// IME 守卫（红线 4，规格见 docs/05）。
// compositionstart → compositionend 期间：正在编辑节点的 DOM 绝对不可被触碰，
// 不发 setText，不应用 refresh（存入 pendingRefresh，commit 后再应用）。
// 中文输入丢字是最高优先级 bug。

import type { H2W } from '../shared/protocol.js';

export const ime: { composing: boolean; pendingRefresh: H2W | null } = {
  composing: false,
  pendingRefresh: null,
};

export interface ImeCallbacks {
  /** 组合结束：读取 DOM 文本走正常 setText 防抖。 */
  onCommit(target: HTMLElement): void;
  /** 组合结束后应用被搁置的 refresh（只保留最新一条）。 */
  onFlushPendingRefresh(msg: H2W): void;
}

export function installImeGuard(root: HTMLElement, callbacks: ImeCallbacks): void {
  root.addEventListener('compositionstart', () => {
    ime.composing = true;
  });

  root.addEventListener('compositionend', (event) => {
    ime.composing = false;
    const target = event.target;
    if (target instanceof HTMLElement && target.dataset.field) callbacks.onCommit(target);

    const pending = ime.pendingRefresh;
    ime.pendingRefresh = null;
    if (pending) callbacks.onFlushPendingRefresh(pending);
  });
}

/** keydown 一票否决：组合期间把按键完全让给输入法（含 keyCode 229 的旧式上报）。 */
export function isComposingEvent(e: KeyboardEvent): boolean {
  return ime.composing || e.isComposing || e.keyCode === 229;
}
