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

  const textNode = firstTextNode(editable);
  const length = textNode?.textContent?.length ?? 0;
  const offset = Math.max(0, Math.min(pos.offset, length));

  const range = document.createRange();
  if (textNode) range.setStart(textNode, offset);
  else range.setStart(editable, 0);
  range.collapse(true);

  const selection = window.getSelection();
  if (!selection) return false;
  selection.removeAllRanges();
  selection.addRange(range);
  if (document.activeElement !== editable) editable.focus({ preventScroll: true });
  return true;
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

function closestEditable(node: Node): HTMLElement | null {
  const start = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  return start?.closest<HTMLElement>('[data-field]') ?? null;
}

function offsetWithin(editable: HTMLElement, focusNode: Node, focusOffset: number): number {
  if (focusNode === editable) {
    // 选区落在元素本身：focusOffset 是子节点序号，折算成其前面所有文本的长度
    let total = 0;
    for (let i = 0; i < focusOffset && i < editable.childNodes.length; i++) {
      total += editable.childNodes[i].textContent?.length ?? 0;
    }
    return total;
  }
  let total = 0;
  const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current !== null) {
    if (current === focusNode) return total + focusOffset;
    total += current.textContent?.length ?? 0;
    current = walker.nextNode();
  }
  return total;
}

function firstTextNode(el: HTMLElement): Text | null {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  return walker.nextNode() as Text | null;
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
