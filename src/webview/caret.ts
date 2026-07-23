// 光标 save / restore（规格见 docs/05）。
// contenteditable="plaintext-only" 下每个可编辑 div 内只有单个 text node（或空），
// offset 即字符偏移，没有富文本 Range 的复杂度。

export interface CaretPos {
  nodeId: string;
  field: 'text' | 'note';
  offset: number;
}

export function saveCaret(): CaretPos | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.focusNode === null) return null;

  const editable = closestEditable(selection.focusNode);
  if (!editable) return null;
  const nodeEl = editable.closest<HTMLElement>('.node');
  const nodeId = nodeEl?.dataset.id;
  if (!nodeId) return null;

  return {
    nodeId,
    field: editable.dataset.field === 'note' ? 'note' : 'text',
    offset: offsetWithin(editable, selection.focusNode, selection.focusOffset),
  };
}

/** offset 会被 clamp 到新文本长度；目标节点不存在则不动焦点，返回 false。 */
export function restoreCaret(pos: CaretPos): boolean {
  const editable = findEditable(pos.nodeId, pos.field);
  if (!editable) return false;
  const ok = placeCaretAtOffset(editable, pos.offset);
  if (ok && document.activeElement !== editable) editable.focus({ preventScroll: true });
  return ok;
}

export function focusNode(nodeId: string, field: 'text' | 'note' = 'text', offset = 0): boolean {
  return restoreCaret({ nodeId, field, offset });
}

export function findEditable(nodeId: string, field: 'text' | 'note'): HTMLElement | null {
  const nodeEl = document.querySelector<HTMLElement>(`.node[data-id="${cssEscape(nodeId)}"]`);
  return nodeEl?.querySelector<HTMLElement>(`:scope > .node-row > [data-field="${field}"], :scope > [data-field="${field}"]`) ?? null;
}

/** 当前光标所在的可编辑元素（不在任何可编辑区时返回 null）。 */
export function activeEditable(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.dataset.field ? active : null;
}

// ---------- 跨节点上下移动（↑/↓） ----------

/** 光标的屏幕矩形（折叠选区也能拿到零宽矩形）。 */
export function caretRect(): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0 && rect.top === 0) return null;
  return rect;
}

/** 光标是否在该可编辑元素的首/末视觉行（文本换行时也成立）。 */
export function atFirstVisualLine(editable: HTMLElement): boolean {
  const rect = caretRect();
  if (!rect) return true;
  const box = editable.getBoundingClientRect();
  return rect.top - box.top < Math.max(rect.height, 1) / 2;
}

export function atLastVisualLine(editable: HTMLElement): boolean {
  const rect = caretRect();
  if (!rect) return true;
  const box = editable.getBoundingClientRect();
  return box.bottom - rect.bottom < Math.max(rect.height, 1) / 2;
}

/**
 * 把光标放到目标可编辑元素的首行/末行，横向尽量保持在 preferredX。
 * SPEC-GAP: docs/05 只说「列尽量保持」，没给算法；这里用 caretRangeFromPoint 命中同一
 * 横坐标，命中不了就退化到行首/行尾。
 */
export function placeCaretAtLine(editable: HTMLElement, preferredX: number, atEnd: boolean): void {
  editable.focus({ preventScroll: true });
  const box = editable.getBoundingClientRect();
  const y = atEnd ? box.bottom - 2 : box.top + 2;
  const fromPoint = document.caretRangeFromPoint?.(preferredX, y);

  const selection = window.getSelection();
  if (!selection) return;
  if (fromPoint && editable.contains(fromPoint.startContainer)) {
    selection.removeAllRanges();
    selection.addRange(fromPoint);
    return;
  }
  const length = editable.textContent?.length ?? 0;
  placeCaretAtOffset(editable, atEnd ? length : 0);
}

function closestEditable(node: Node): HTMLElement | null {
  const start = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  return start?.closest<HTMLElement>('[data-field]') ?? null;
}

/**
 * 按 innerText 语义遍历：文本节点算自身长度，<br> 算一个换行符。
 * 多行 note 是 text + <br> 的混合，只看第一个文本节点会把换行后的偏移全算错。
 */
function contentNodes(editable: HTMLElement): Node[] {
  const out: Node[] = [];
  const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let current = walker.nextNode();
  while (current !== null) {
    if (current.nodeType === Node.TEXT_NODE || (current as HTMLElement).tagName === 'BR') {
      out.push(current);
    }
    current = walker.nextNode();
  }
  return out;
}

function offsetWithin(editable: HTMLElement, focusNode: Node, focusOffset: number): number {
  if (focusNode === editable) {
    // 选区落在元素本身：focusOffset 是子节点序号，折算成其前面所有内容的长度
    let total = 0;
    for (let i = 0; i < focusOffset && i < editable.childNodes.length; i++) {
      const child = editable.childNodes[i];
      total += (child as HTMLElement).tagName === 'BR' ? 1 : (child.textContent?.length ?? 0);
    }
    return total;
  }
  let total = 0;
  for (const node of contentNodes(editable)) {
    if (node === focusNode) return total + focusOffset;
    total += node.nodeType === Node.TEXT_NODE ? (node.textContent?.length ?? 0) : 1;
  }
  return total;
}

/** 把光标放到该可编辑元素的第 offset 个字符处（offset 按 innerText 语义 clamp）。 */
function placeCaretAtOffset(editable: HTMLElement, offset: number): boolean {
  const selection = window.getSelection();
  if (!selection) return false;

  const range = document.createRange();
  let remaining = Math.max(0, offset);
  let placed = false;

  for (const node of contentNodes(editable)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) {
        range.setStart(node, remaining);
        placed = true;
        break;
      }
      remaining -= length;
    } else {
      if (remaining === 0) {
        range.setStartBefore(node);
        placed = true;
        break;
      }
      remaining -= 1;
    }
  }

  if (!placed) {
    const last = contentNodes(editable).at(-1);
    if (last && last.nodeType === Node.TEXT_NODE) range.setStart(last, last.textContent?.length ?? 0);
    else if (last) range.setStartAfter(last);
    else range.setStart(editable, 0);
  }

  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
