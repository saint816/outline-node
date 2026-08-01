// 实时搜索过滤（规格见 docs/05）。
// 过滤只切 class、不动 DOM 结构（性能，见 docs/07）。

import type { Block, OutlineNode } from '../core/model.js';
import { t } from './i18n.js';

const DEBOUNCE_MS = 150;

export class SearchBox {
  readonly el: HTMLElement;
  private readonly input: HTMLInputElement;
  private timer: number | null = null;

  constructor(private readonly onQuery: (query: string) => void) {
    this.el = document.createElement('div');
    this.el.className = 'toolbar';

    this.input = document.createElement('input');
    this.input.className = 'search-input';
    this.input.type = 'search';
    this.input.placeholder = t('search.placeholder');
    this.input.setAttribute('aria-label', t('search.ariaLabel'));
    this.input.addEventListener('input', () => this.schedule());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.clear();
      }
    });

    this.el.append(this.input);
  }

  get query(): string {
    return this.input.value.trim();
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  clear(): void {
    if (this.input.value === '') return;
    this.input.value = '';
    this.emit();
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.emit();
    }, DEBOUNCE_MS) as unknown as number;
  }

  private emit(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.onQuery(this.query);
  }
}

/**
 * 过滤已渲染的节点（只切 class、不动 DOM）：搜索命中过滤 + 隐藏已完成，合并成一趟。
 * 一个 .node 只要被任一过滤器命中就 .hidden——两者取并集，互不覆盖。
 * 搜索：命中节点与其全部祖先显示；隐藏已完成：已完成节点连同整棵子树收起。
 */
export function applyFilters(
  root: HTMLElement,
  blocks: readonly Block[],
  query: string,
  hideCompleted: boolean,
): void {
  const nodes = root.querySelectorAll<HTMLElement>('.node');
  const searching = query !== '';
  const search = searching ? matchTree(blocks, query.toLowerCase()) : null;
  const completed = hideCompleted ? collectCompletedSubtrees(blocks) : null;

  root.classList.toggle('searching', searching);
  for (const el of nodes) {
    const id = el.dataset.id ?? '';
    const hiddenBySearch = search !== null && !search.visible.has(id);
    const hiddenByCompleted = completed !== null && completed.has(id);
    el.classList.toggle('hidden', hiddenBySearch || hiddenByCompleted);
    el.classList.toggle('search-hit', search !== null && search.hits.has(id));
  }
}

/** 已完成节点及其整棵子树的 id（隐藏已完成时整块收起）。 */
function collectCompletedSubtrees(blocks: readonly Block[]): Set<string> {
  const hidden = new Set<string>();
  const markSubtree = (node: OutlineNode): void => {
    hidden.add(node.id);
    for (const child of node.children) markSubtree(child);
  };
  const walk = (node: OutlineNode): void => {
    if (node.checked === true) markSubtree(node);
    else for (const child of node.children) walk(child);
  };
  for (const block of blocks) {
    if (block.kind !== 'list') continue;
    for (const root of block.roots) walk(root);
  }
  return hidden;
}

function matchTree(
  blocks: readonly Block[],
  needle: string,
): { visible: Set<string>; hits: Set<string> } {
  const visible = new Set<string>();
  const hits = new Set<string>();

  const walk = (node: OutlineNode, ancestors: string[]): void => {
    const haystack = (node.text + '\n' + (node.note ?? '')).toLowerCase();
    if (haystack.includes(needle)) {
      hits.add(node.id);
      visible.add(node.id);
      for (const id of ancestors) visible.add(id);
    }
    const nextAncestors = [...ancestors, node.id];
    for (const child of node.children) walk(child, nextAncestors);
  };

  for (const block of blocks) {
    if (block.kind !== 'list') continue;
    for (const root of block.roots) walk(root, []);
  }
  return { visible, hits };
}
