// keyed 增量渲染（规格见 docs/05、07）。renderer 只读 store 的树，绝不改树。

import type { Block, OutlineNode } from '../core/model.js';
import type { DocSnapshot } from '../shared/protocol.js';
import { ime } from './ime.js';
import { NodeView, createRawBlockView, updateRawBlockView } from './nodeView.js';

export interface PatchOptions {
  dirtyIds?: Set<string>;
  /** 折叠的节点 id：其子树根本不构建 DOM（不是 display:none，见 docs/07）。 */
  folded?: ReadonlySet<string>;
  /** 非 null 时只渲染该子树（zoom）。 */
  zoomRootId?: string | null;
}

export interface PatchResult {
  /** 首帧分片：本次没挂完，调用方应在下一帧再 patch 一次（见 docs/07）。 */
  truncated: boolean;
}

const NO_FOLDS: ReadonlySet<string> = new Set<string>();

/** 首帧同步挂载的节点数上限；其余分片追加，大文件不白屏。 */
const FIRST_CHUNK = 200;
/** 后续每帧再挂多少个。 */
const NEXT_CHUNK = 600;

export class Renderer {
  private readonly nodes = new Map<string, NodeView>();
  private readonly rawBlocks = new Map<string, HTMLElement>();
  private readonly listBlocks = new Map<string, HTMLElement>();
  private zoomContainer: HTMLElement | null = null;
  private folded: ReadonlySet<string> = NO_FOLDS;
  /** 本次 patch 还允许新建多少个节点（Infinity = 不限）。 */
  private budget = Number.POSITIVE_INFINITY;
  private created = 0;
  private truncated = false;

  constructor(private readonly root: HTMLElement) {}

  patch(doc: DocSnapshot, opts: PatchOptions = {}): PatchResult {
    this.folded = opts.folded ?? NO_FOLDS;
    this.beginBudget();
    const seenNodes = new Set<string>();
    const zoomRoot = opts.zoomRootId ? findNode(doc.blocks, opts.zoomRootId) : null;

    let desired: HTMLElement[];
    if (zoomRoot) {
      // zoom 状态下其余部分完全不在 DOM（见 docs/07）
      const container = this.ensureZoomContainer();
      this.patchNodes(container, [zoomRoot], seenNodes);
      desired = [container];
    } else {
      desired = doc.blocks.map((block) => this.patchBlock(block, seenNodes));
    }
    reorder(this.root, desired);

    // 分片挂载期间不回收：还没轮到构建的节点不该被当成「已消失」
    if (!this.truncated) {
      this.recycle(seenNodes, zoomRoot ? new Set<string>() : new Set(doc.blocks.map((b) => b.id)));
    }
    return { truncated: this.truncated };
  }

  /**
   * 首帧只同步挂前 FIRST_CHUNK 个节点，之后每帧再放宽 NEXT_CHUNK（见 docs/07）。
   * 只在「首次挂载且节点很多」时启用；一旦挂完就恢复无限预算，普通编辑 patch 不受影响。
   */
  private beginBudget(): void {
    this.created = 0;
    if (this.truncated) {
      this.budget = NEXT_CHUNK;
      this.truncated = false;
      return;
    }
    this.budget = this.nodes.size === 0 ? FIRST_CHUNK : Number.POSITIVE_INFINITY;
  }

  elementFor(id: string): HTMLElement | null {
    return this.nodes.get(id)?.el ?? null;
  }

  /** 回收已消失（含被折叠而不再挂载）的节点与块，避免 keyed map 泄漏。 */
  private recycle(seenNodes: Set<string>, liveBlocks: Set<string>): void {
    for (const [id, view] of this.nodes) {
      if (!seenNodes.has(id)) {
        view.el.remove();
        this.nodes.delete(id);
      }
    }
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

  private ensureZoomContainer(): HTMLElement {
    if (this.zoomContainer === null) {
      this.zoomContainer = document.createElement('div');
      this.zoomContainer.className = 'list-block zoomed';
      this.zoomContainer.setAttribute('role', 'tree');
    }
    return this.zoomContainer;
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
      el.setAttribute('role', 'tree');
      this.listBlocks.set(block.id, el);
    }
    this.patchNodes(el, block.roots, seen);
    return el;
  }

  private patchNodes(
    container: HTMLElement,
    nodes: readonly OutlineNode[],
    seen: Set<string>,
    depth = 0,
  ): void {
    const desired: HTMLElement[] = [];

    for (const node of nodes) {
      seen.add(node.id);
      const folded = this.folded.has(node.id);
      let view = this.nodes.get(node.id);
      if (!view) {
        if (this.created >= this.budget) {
          this.truncated = true;
          seen.delete(node.id);
          break;
        }
        this.created++;
        view = new NodeView(node, { folded, depth });
        this.nodes.set(node.id, view);
      } else {
        view.update(node, { skipText: shouldSkipText(view, node), folded, depth });
      }
      desired.push(view.el);

      // 折叠子树不构建 DOM：不访问 children → 它们不会进 seen → 由 recycle 卸载
      if (!folded) this.patchNodes(view.childrenEl, node.children, seen, depth + 1);
      else if (view.childrenEl.firstChild) view.childrenEl.replaceChildren();
    }

    reorder(container, desired);
  }
}

function findNode(blocks: readonly Block[], id: string): OutlineNode | null {
  for (const block of blocks) {
    if (block.kind !== 'list') continue;
    const hit = search(block.roots, id);
    if (hit) return hit;
  }
  return null;
}

function search(nodes: readonly OutlineNode[], id: string): OutlineNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = search(node.children, id);
    if (hit) return hit;
  }
  return null;
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
  while (cursor !== null) {
    const next = cursor.nextSibling;
    if (!desired.includes(cursor as HTMLElement)) container.removeChild(cursor);
    cursor = next;
  }
}
