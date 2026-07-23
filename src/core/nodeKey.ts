// 折叠持久化 key（规格见 docs/06）。
// 刻意不掺入祖先路径：move/indent/拖拽后 key 不变 → 折叠保留；只有 rename 使 key 失效，
// 有 blockId 的节点连 rename 都免疫。

import { forEachNode, type Block, type OutlineNode } from './model.js';

export function nodeKey(node: OutlineNode, occurrenceIndex: number): string {
  if (node.blockId !== null) return `b:${node.blockId}`;
  const base = `h:${hash36(node.text)}`;
  return occurrenceIndex > 0 ? `${base}#${occurrenceIndex}` : base;
}

/**
 * 整篇文档的 id → key 映射。occurrenceIndex 按文档先序累计，解决重复文本碰撞。
 * SPEC-GAP: docs/06 只给了单节点签名；两端都需要「按当前树算出全量映射」这一步，
 * 放在 core 里保证 host 与 webview 算出的 key 完全一致。
 */
export function nodeKeys(blocks: readonly Block[]): Map<string, string> {
  const seen = new Map<string, number>();
  const keys = new Map<string, string>();
  forEachNode(blocks, (node) => {
    if (node.blockId !== null) {
      keys.set(node.id, nodeKey(node, 0));
      return;
    }
    const base = `h:${hash36(node.text)}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    keys.set(node.id, nodeKey(node, occurrence));
  });
  return keys;
}

/** FNV-1a 32 位哈希转 base36 短串。 */
export function hash36(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}
