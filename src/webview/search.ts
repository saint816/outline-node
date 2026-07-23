// 实时搜索过滤（规格见 docs/05）。
// 过滤只切 class、不动 DOM 结构（性能，见 docs/07）。

import type { Block, OutlineNode } from '../core/model.js';

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
    this.input.placeholder = '搜索节点…';
    this.input.setAttribute('aria-label', '搜索节点');
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
 * 按 query 过滤已渲染的节点：命中节点与其全部祖先显示，其余加 .hidden。
 * 匹配大小写不敏感子串，命中 text 与 note。
 */
export function applySearchFilter(root: HTMLElement, blocks: readonly Block[], query: string): void {
  const nodes = root.querySelectorAll<HTMLElement>('.node');
  if (query === '') {
    for (const el of nodes) {
      el.classList.remove('hidden', 'search-hit');
    }
    root.classList.remove('searching');
    return;
  }

  const { visible, hits } = matchTree(blocks, query.toLowerCase());
  root.classList.add('searching');
  for (const el of nodes) {
    const id = el.dataset.id ?? '';
    el.classList.toggle('hidden', !visible.has(id));
    el.classList.toggle('search-hit', hits.has(id));
  }
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
