import type { OutlineNode } from './model.js';

/** Derived presentation only: Markdown remains the source of truth. */
export function dividerKind(node: OutlineNode): 'plain' | 'title' | null {
  if (node.checked !== null || node.mirror !== null) return null;
  if (node.note?.trim() === '***') return 'title';
  return node.note === null && node.text.trim() === '***' ? 'plain' : null;
}

export function canMakeDivider(node: OutlineNode): boolean {
  return node.checked === null && node.mirror === null && node.note === null;
}
