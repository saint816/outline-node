// 高代码块折叠：纯 Webview 状态，绝不写进 Markdown。

import { t } from './i18n.js';
import { originalIdOf } from './mirror.js';

const COLLAPSE_HEIGHT = 240;

export class CodeCollapseController {
  private readonly expanded = new Set<string>();
  private readonly pending = new Set<HTMLElement>();
  private scheduled = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly onStateChanged: () => void,
  ) {
    new MutationObserver((records) => {
      for (const record of records) {
        const owner = (record.target as Element).closest?.<HTMLElement>('.code-block');
        if (owner) this.queue(owner);
        for (const added of record.addedNodes) {
          if (!(added instanceof HTMLElement)) continue;
          if (added.classList.contains('code-block')) this.queue(added);
          for (const block of added.querySelectorAll<HTMLElement>('.code-block')) this.queue(block);
        }
      }
    }).observe(root, { childList: true, subtree: true });

    root.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('.code-expand');
      const block = button?.closest<HTMLElement>('.code-block');
      if (!button || !block) return;
      event.preventDefault();
      const key = keyOf(block);
      if (key === null) return;
      if (this.expanded.has(key)) this.expanded.delete(key);
      else this.expanded.add(key);
      this.syncBlock(block);
      this.onStateChanged();
    });

    root.addEventListener('focusin', (event) => {
      const area = event.target;
      if (!(area instanceof HTMLTextAreaElement) || !area.classList.contains('code-input')) return;
      const block = area.closest<HTMLElement>('.code-block');
      const key = block && keyOf(block);
      if (!block || key === null || this.expanded.has(key)) return;
      this.expanded.add(key); // 编辑时不能把光标藏在裁切区域内
      this.syncBlock(block);
      this.onStateChanged();
    });
  }

  restore(keys: readonly string[]): void {
    this.expanded.clear();
    for (const key of keys) this.expanded.add(key);
    for (const block of this.root.querySelectorAll<HTMLElement>('.code-block')) this.queue(block);
  }

  state(): string[] {
    return [...this.expanded];
  }

  private queue(block: HTMLElement): void {
    this.pending.add(block);
    if (this.scheduled) return;
    this.scheduled = true;
    // 高度测量会 query 全部代码块并触发布局，不能挤进 renderer.patch 后的首个 rAF：
    // 5000 节点外部 refresh 的完成判据就在那一帧（docs/07 的 50ms 红线）。
    // 放进空闲期合并测量；输入与语言切换仍走 syncArea 立即更新当前块。
    const run = (): void => {
      this.scheduled = false;
      const blocks = [...this.pending];
      this.pending.clear();
      for (const item of blocks) if (item.isConnected) this.syncBlock(item);
    };
    // lib.dom 把 requestIdleCallback 声明成必有 API，但旧 Webview 运行时未必实现；
    // 显式收窄为可选能力，避免 fallback 分支被 TypeScript 判成 never。
    const requestIdle = (
      window as Window & {
        requestIdleCallback?: (
          callback: IdleRequestCallback,
          options?: IdleRequestOptions,
        ) => number;
      }
    ).requestIdleCallback;
    if (typeof requestIdle === 'function') requestIdle.call(window, run, { timeout: 200 });
    else globalThis.setTimeout(run, 32);
  }

  syncArea(area: HTMLTextAreaElement): void {
    const block = area.closest<HTMLElement>('.code-block');
    if (block) this.syncBlock(block);
  }

  private syncBlock(block: HTMLElement): void {
    const area = block.querySelector<HTMLTextAreaElement>('textarea.code-input');
    const key = keyOf(block);
    if (!area || key === null) return;
    const tall = area.scrollHeight > COLLAPSE_HEIGHT;
    block.classList.toggle('code-tall', tall);
    block.classList.toggle('code-expanded', tall && this.expanded.has(key));

    let button = block.querySelector<HTMLButtonElement>(':scope > .code-expand');
    if (!tall) {
      button?.remove();
      return;
    }
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'code-expand';
      block.append(button);
    }
    const open = this.expanded.has(key);
    button.textContent = open ? t('code.collapse') : t('code.expand');
    button.setAttribute('aria-expanded', String(open));
  }
}

function keyOf(block: HTMLElement): string | null {
  const blockId = block.dataset.blockId;
  if (blockId) return `raw:${blockId}`;
  const nodeId = block.closest<HTMLElement>('.node')?.dataset.id;
  return nodeId ? `node:${originalIdOf(nodeId)}` : null;
}
