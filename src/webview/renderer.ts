// keyed 增量渲染（规格见 docs/05、07）。renderer 只读 store 的树，绝不改树。

import type { Block, OutlineNode } from '../core/model.js';
import type { DocSnapshot } from '../shared/protocol.js';
import { ime } from './ime.js';
import { NodeView, createRawBlockView, updateRawBlockView } from './nodeView.js';

export interface PatchOptions {
  dirtyIds?: Set<string>;
}

export class Renderer {
  private readonly nodes = new Map<string, NodeView>();
  private readonly rawBlocks = new Map<string, HTMLElement>();
  private readonly listBlocks = new Map<string, HTMLElement>();

  constructor(private readonly root: HTMLElement) {}

  patch(doc: DocSnapshot, _opts: PatchOptions = {}): void {
    const seenNodes = new Set<string>();
    const desired: HTMLElement[] = [];

    for (const block of doc.blocks) {
      desired.push(this.patchBlock(block, seenNodes));
    }
    reorder(this.root, desired);

    // 回收已消失的节点/块，避免 keyed map 泄漏
    for (const [id, view] of this.nodes) {
      if (!seenNodes.has(id)) {
        view.el.remove();
        this.nodes.delete(id);
      }
    }
    const liveBlocks = new Set(doc.blocks.map((b) => b.id));
    for (const [id, el] of this.rawBlocks) {
      if (!liveBlocks.has(id)) {
        el.remove();
        this.rawBlocks.delete(id);
      }
    }
    for (const [id, el] of this.listBlocks) {
      if (!liveBlocks.has(id)) {
        el.remove();
        this.listBlocks.delete(id);
      }
    }
  }

  elementFor(id: string): HTMLElement | null {
    return this.nodes.get(id)?.el ?? null;
  }

  private patchBlock(block: Block, seen: Set<string>): HTMLElement {
    if (block.kind === 'raw') {
      let el = this.rawBlocks.get(block.id);
      if (!el) {
        el = createRawBlockView(block.lines);
        this.rawBlocks.set(block.id, el);
      } else {
        updateRawBlockView(el, block.lines);
      }
      return el;
    }

    let el = this.listBlocks.get(block.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'list-block';
      this.listBlocks.set(block.id, el);
    }
    this.patchNodes(el, block.roots, seen);
    return el;
  }

  private patchNodes(container: HTMLElement, nodes: readonly OutlineNode[], seen: Set<string>): void {
    const desired: HTMLElement[] = [];

    for (const node of nodes) {
      seen.add(node.id);
      let view = this.nodes.get(node.id);
      if (!view) {
        view = new NodeView(node);
        this.nodes.set(node.id, view);
      } else {
        view.update(node, { skipText: shouldSkipText(view, node) });
      }
      desired.push(view.el);
      this.patchNodes(view.childrenEl, node.children, seen);
    }

    reorder(container, desired);
  }
}

/**
 * 第一原则（docs/05）：正在编辑（focus 所在）且文本未变的节点跳过一切文本 DOM 操作——
 * 原生光标根本不动，这是光标稳定的根基。IME 组合期间无条件跳过（红线 4）。
 */
function shouldSkipText(view: NodeView, node: OutlineNode): boolean {
  const active = document.activeElement;
  if (!active || !view.el.contains(active)) return false;
  if (ime.composing) return true;
  const field = (active as HTMLElement).dataset?.field;
  if (field === 'text') return active.textContent === node.text;
  if (field === 'note') return (active as HTMLElement).innerText === (node.note ?? '');
  return false;
}

/**
 * 让 container 的子元素顺序与 desired 一致：只移动/插入现存元素，不整树重建。
 * 移动用 insertBefore（DOM 原生的「移动」语义），被移动元素内部状态与焦点都保留。
 */
function reorder(container: HTMLElement, desired: readonly HTMLElement[]): void {
  let cursor: ChildNode | null = container.firstChild;
  for (const el of desired) {
    if (cursor === el) {
      cursor = cursor.nextSibling;
      continue;
    }
    container.insertBefore(el, cursor);
  }
  // 多余的尾部元素由调用方按 id 回收（这里只摘掉不在 desired 里的直接子节点）
  while (cursor !== null) {
    const next = cursor.nextSibling;
    if (!desired.includes(cursor as HTMLElement)) container.removeChild(cursor);
    cursor = next;
  }
}
