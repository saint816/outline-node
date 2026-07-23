// 镜像引用的渲染层展开（规格见 docs/06）。
// 数据层永远只有一份：文件里是原节点 + N 行 `![[#^id]]` 引用；这里把引用行展开成
// 「第二个视图」，视图内节点用复合 id `${mirrorNodeId}/${originalId}`，保证 renderer 的
// keyed Map 不冲突。编辑时把复合 id 重写回原始 id（见 store.resolveId），
// 于是原视图与所有镜像视图在下一次 patch 自然一致。
//
// 本文件零 DOM 依赖，可直接在 vitest 里测。

import type { Block, OutlineNode } from '../core/model.js';

export type MirrorState =
  | 'none' // 普通节点
  | 'mirror' // 镜像展开出来的节点
  | 'broken' // 引用的 blockId 不存在
  | 'cycle'; // 循环引用

export interface ViewNode extends OutlineNode {
  children: ViewNode[];
  /** 数据层的真实 id（复合 id 的后半段）。 */
  originalId: string;
  mirrorState: MirrorState;
  /** 镜像行在文件里还带着子行时为 true：渲染层忽略它们，UI 给个提示（见 docs/06）。 */
  ignoredChildren: boolean;
}

export type ViewBlock =
  | { kind: 'raw'; id: string; lines: string[] }
  | { kind: 'list'; id: string; roots: ViewNode[] };

export const COMPOSITE_SEPARATOR = '/';

/** 复合 id → 数据层 id。普通 id 原样返回。 */
export function originalIdOf(id: string): string {
  const at = id.lastIndexOf(COMPOSITE_SEPARATOR);
  return at === -1 ? id : id.slice(at + 1);
}

export function isCompositeId(id: string): boolean {
  return id.includes(COMPOSITE_SEPARATOR);
}

/** Obsidian 原生块嵌入语法（见 docs/06）。 */
export function mirrorLink(blockId: string): string {
  return `![[#^${blockId}]]`;
}

/** 生成文档内唯一的 6 位 base36 block id。 */
export function generateBlockId(blocks: readonly Block[], random: () => number = Math.random): string {
  const used = new Set<string>();
  forEach(blocks, (node) => {
    if (node.blockId !== null) used.add(node.blockId);
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = Math.floor(random() * 36 ** 6)
      .toString(36)
      .padStart(6, '0');
    if (!used.has(candidate)) return candidate;
  }
  return 'b' + Date.now().toString(36).slice(-5);
}

/** 文档里是否存在镜像行；没有就走快路径，避免每帧白拷一棵树。 */
export function hasMirrors(blocks: readonly Block[]): boolean {
  let found = false;
  forEach(blocks, (node) => {
    if (node.mirror !== null) found = true;
  });
  return found;
}

/**
 * 把镜像行展开成视图树。无镜像时返回原树（零拷贝）。
 * 环检测：展开时维护祖先 blockId 集合，遇到已在集合中的引用 → 标 cycle，不展开。
 */
export function expandMirrors(blocks: readonly Block[]): ViewBlock[] {
  if (!hasMirrors(blocks)) return blocks as ViewBlock[];

  const byBlockId = new Map<string, OutlineNode>();
  forEach(blocks, (node) => {
    if (node.blockId !== null && !byBlockId.has(node.blockId)) byBlockId.set(node.blockId, node);
  });

  const expandNode = (node: OutlineNode, prefix: string, ancestors: Set<string>): ViewNode => {
    const id = prefix === '' ? node.id : prefix + COMPOSITE_SEPARATOR + node.id;

    if (node.mirror !== null) {
      const target = byBlockId.get(node.mirror);
      if (!target) {
        // 断链：保留原文 `![[#^id]]`，只读渲染，绝不静默删除
        return view(node, id, 'broken', []);
      }
      if (ancestors.has(node.mirror)) {
        return view(node, id, 'cycle', []);
      }

      const nextAncestors = new Set(ancestors).add(node.mirror);
      const nextPrefix = id;
      const mirrored: ViewNode = {
        ...target,
        id: nextPrefix + COMPOSITE_SEPARATOR + target.id,
        originalId: target.id,
        mirrorState: 'mirror',
        ignoredChildren: node.children.length > 0,
        children: target.children.map((child) => expandNode(child, nextPrefix, nextAncestors)),
      };
      return mirrored;
    }

    const nextAncestors =
      node.blockId === null ? ancestors : new Set(ancestors).add(node.blockId);
    return view(
      node,
      id,
      'none',
      node.children.map((child) => expandNode(child, prefix, nextAncestors)),
    );
  };

  return blocks.map((block) =>
    block.kind === 'raw'
      ? block
      : { kind: 'list', id: block.id, roots: block.roots.map((root) => expandNode(root, '', new Set())) },
  );
}

function view(node: OutlineNode, id: string, state: MirrorState, children: ViewNode[]): ViewNode {
  return {
    ...node,
    id,
    originalId: node.id,
    mirrorState: state,
    ignoredChildren: false,
    children,
  };
}

function forEach(blocks: readonly Block[], visit: (node: OutlineNode) => void): void {
  const walk = (nodes: readonly OutlineNode[]): void => {
    for (const node of nodes) {
      visit(node);
      walk(node.children);
    }
  };
  for (const block of blocks) if (block.kind === 'list') walk(block.roots);
}
