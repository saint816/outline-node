// pointer 拖拽排序（规格见 docs/05）。
// 不用 HTML5 DnD：ghost 图像与 drop 目标控制太差。松手时只发一条 move op。

import type { Store, VisibleRow } from './store.js';

const DRAG_THRESHOLD_PX = 4;
const EDGE_SCROLL_PX = 40;
const EDGE_SCROLL_STEP = 12;

interface DropTarget {
  parentId: string | null;
  index: number;
  /** 指示线的位置（相对 root） */
  top: number;
  left: number;
}

export function installDragAndDrop(root: HTMLElement, store: Store): void {
  let dragId: string | null = null;
  let startX = 0;
  let startY = 0;
  let active = false;
  let target: DropTarget | null = null;
  let scrollTimer: number | null = null;
  let indicator: HTMLElement | null = null;

  const indentPx = (): number => {
    const raw = getComputedStyle(root).getPropertyValue('--outline-indent').trim();
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) && value > 0 ? value : 17;
  };

  const cleanup = (): void => {
    if (dragId !== null) {
      const el = root.querySelector<HTMLElement>(`.node[data-id="${cssEscape(dragId)}"]`);
      el?.classList.remove('dragging');
    }
    indicator?.remove();
    indicator = null;
    if (scrollTimer !== null) {
      clearInterval(scrollTimer);
      scrollTimer = null;
    }
    dragId = null;
    active = false;
    target = null;
  };

  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const bullet = (e.target as HTMLElement | null)?.closest?.('.bullet');
    if (!bullet) return;
    const id = bullet.closest<HTMLElement>('.node')?.dataset.id;
    if (!id) return;
    dragId = id;
    startX = e.clientX;
    startY = e.clientY;
    active = false;
  });

  root.addEventListener('pointermove', (e) => {
    if (dragId === null) return;
    if (!active) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD_PX) return;
      active = true;
      root.querySelector<HTMLElement>(`.node[data-id="${cssEscape(dragId)}"]`)?.classList.add('dragging');
      indicator = document.createElement('div');
      indicator.className = 'drop-indicator';
      root.append(indicator);
      scrollTimer = setInterval(() => autoScroll(), 30) as unknown as number;
    }
    e.preventDefault();
    lastPointerY = e.clientY;
    target = computeDropTarget(store, root, dragId, e.clientX, e.clientY, indentPx());
    if (indicator) {
      indicator.hidden = target === null;
      if (target) {
        indicator.style.top = `${target.top}px`;
        indicator.style.left = `${target.left}px`;
      }
    }
  });

  const finish = (commit: boolean): void => {
    if (active && commit && dragId !== null && target !== null) {
      store.dispatch({ op: 'move', id: dragId, parentId: target.parentId, index: target.index });
    }
    cleanup();
  };

  root.addEventListener('pointerup', () => finish(true));
  root.addEventListener('pointercancel', () => finish(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && active) {
      e.preventDefault();
      finish(false);
    }
  });

  let lastPointerY = 0;
  function autoScroll(): void {
    if (!active) return;
    if (lastPointerY < EDGE_SCROLL_PX) window.scrollBy(0, -EDGE_SCROLL_STEP);
    else if (lastPointerY > window.innerHeight - EDGE_SCROLL_PX) window.scrollBy(0, EDGE_SCROLL_STEP);
  }
}

/**
 * 由指针位置算出插入间隙与目标深度。
 * 间隙 = 指针上方最后一行之后；深度由水平偏移换算，并夹在该间隙的合法区间
 * 「下一行深度 ~ 上一行深度 + 1」内（见 docs/05）。
 */
export function computeDropTarget(
  store: Store,
  root: HTMLElement,
  dragId: string,
  pointerX: number,
  pointerY: number,
  indentPx: number,
): DropTarget | null {
  const dragged = store.findNode(dragId);
  if (!dragged) return null;

  const excluded = subtreeIds(store, dragId);
  const dragRow = store.visibleRows().find((row) => row.node.id === dragId);
  if (!dragRow) return null;

  const rows = store
    .visibleRows()
    // v1：拖拽限制在同一 ListBlock 内；自身子树不能当落点
    .filter((row) => row.blockId === dragRow.blockId && !excluded.has(row.node.id))
    .map((row) => ({ row, el: elementFor(root, row.node.id) }))
    .filter((entry): entry is { row: VisibleRow; el: HTMLElement } => entry.el !== null)
    .map((entry) => ({ ...entry, rect: entry.el.getBoundingClientRect() }));

  if (rows.length === 0) return null;

  let afterIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    const rowEl = rowRect(rows[i].el);
    if (pointerY >= rowEl.top + rowEl.height / 2) afterIndex = i;
  }

  const after = afterIndex >= 0 ? rows[afterIndex] : null;
  const next = rows[afterIndex + 1] ?? null;

  const maxDepth = after ? after.row.depth + 1 : 0;
  const minDepth = next ? next.row.depth : 0;
  const rootRect = root.getBoundingClientRect();
  const wanted = Math.round((pointerX - rootRect.left) / Math.max(indentPx, 1)) - 1;
  const depth = Math.max(Math.min(minDepth, maxDepth), Math.min(maxDepth, Math.max(minDepth, wanted)));

  const placement = resolvePlacement(rows.map((r) => r.row), after?.row ?? null, depth);
  if (!placement) return null;

  const gapY = after ? rowRect(after.el).bottom : rowRect(rows[0].el).top;
  return {
    ...placement,
    top: gapY - rootRect.top,
    left: depth * indentPx,
  };
}

/** (插入到 after 之后, 目标深度) → (parentId, index)。index 按「摘除前」坐标。 */
function resolvePlacement(
  rows: readonly VisibleRow[],
  after: VisibleRow | null,
  depth: number,
): { parentId: string | null; index: number } | null {
  if (after === null) {
    const first = rows[0];
    return first ? { parentId: first.parentId, index: first.index } : null;
  }
  if (depth > after.depth) return { parentId: after.node.id, index: 0 };

  let current: VisibleRow | undefined = after;
  while (current && current.depth > depth) {
    current = rows.find((row) => row.node.id === current!.parentId);
  }
  if (!current) return null;
  return { parentId: current.parentId, index: current.index + 1 };
}

function subtreeIds(store: Store, id: string): Set<string> {
  const out = new Set<string>();
  const node = store.findNode(id);
  if (!node) return out;
  const walk = (n: { id: string; children: { id: string; children: unknown[] }[] }): void => {
    out.add(n.id);
    for (const child of n.children) walk(child as never);
  };
  walk(node as never);
  return out;
}

function elementFor(root: HTMLElement, id: string): HTMLElement | null {
  const el = root.querySelector<HTMLElement>(`.node[data-id="${cssEscape(id)}"]`);
  return el && !el.classList.contains('hidden') ? el : null;
}

/** 只量这一行本身（.node-row），不含子树。 */
function rowRect(nodeEl: HTMLElement): DOMRect {
  const row = nodeEl.querySelector<HTMLElement>(':scope > .node-row');
  return (row ?? nodeEl).getBoundingClientRect();
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
