// 消息协议——唯一契约（规格见 docs/04-sync-protocol.md）。
// 红线 9：改协议必须同步改 docs/04，两端同时改，禁止私加字段绕过类型。
// 本文件只有类型、纯函数守卫与快照构造，无业务逻辑。

import type { Block, IndentUnit, OutlineDoc, OutlineNode } from '../core/model.js';
import type { Op } from '../core/ops.js';

// ---------- 快照 ----------

/** 跨消息边界传输的纯数据快照：其中所有 OutlineNode.raw === null（见 docs/02）。 */
export type DocSnapshot = {
  blocks: Block[];
  indentUnit: IndentUnit;
};

export type NodeSnapshot = OutlineNode;

/** 从 host 侧带 raw 的权威树构造快照（深拷贝 + 丢弃 raw）。 */
export function toSnapshot(doc: OutlineDoc): DocSnapshot {
  return {
    indentUnit: doc.indentUnit,
    blocks: doc.blocks.map((block) =>
      block.kind === 'raw'
        ? { kind: 'raw', id: block.id, lines: [...block.lines] }
        : { kind: 'list', id: block.id, roots: block.roots.map(stripRaw) },
    ),
  };
}

function stripRaw(node: OutlineNode): NodeSnapshot {
  return {
    id: node.id,
    text: node.text,
    checked: node.checked,
    note: node.note,
    blockId: node.blockId,
    mirror: node.mirror,
    children: node.children.map(stripRaw),
    raw: null,
  };
}

// ---------- 配置 ----------

export interface EditorConfig {
  defaultIndent: IndentUnit;
  defaultFold: 'none' | 'firstLevel';
  rememberFolding: boolean;
}

// ---------- webview → host ----------

export type W2H =
  | { type: 'ready' }
  | { type: 'edit'; baseVersion: number; seq: number; ops: Op[] }
  | { type: 'requestUndo' }
  | { type: 'requestRedo' }
  | { type: 'saveFolding'; foldedKeys: string[] };

// ---------- host → webview ----------

export type H2W =
  | {
      type: 'init';
      snapshot: DocSnapshot;
      version: number;
      foldedKeys: string[];
      config: EditorConfig;
    }
  | { type: 'ack'; seq: number; version: number }
  | {
      type: 'refresh';
      snapshot: DocSnapshot;
      version: number;
      cause: 'external' | 'undo' | 'conflict';
    };

// ---------- 边界类型守卫 ----------
// 消息来自另一个进程/渲染器，是 unknown。这里把它收窄成协议类型，避免 any 逃逸。

export function asW2H(raw: unknown): W2H | null {
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case 'ready':
    case 'requestUndo':
    case 'requestRedo':
      return { type: raw.type };
    case 'edit':
      return typeof raw.baseVersion === 'number' &&
        typeof raw.seq === 'number' &&
        Array.isArray(raw.ops)
        ? { type: 'edit', baseVersion: raw.baseVersion, seq: raw.seq, ops: raw.ops as Op[] }
        : null;
    case 'saveFolding':
      return Array.isArray(raw.foldedKeys) && raw.foldedKeys.every((k) => typeof k === 'string')
        ? { type: 'saveFolding', foldedKeys: raw.foldedKeys as string[] }
        : null;
    default:
      return null;
  }
}

export function asH2W(raw: unknown): H2W | null {
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case 'init':
      return isRecord(raw.snapshot) &&
        typeof raw.version === 'number' &&
        Array.isArray(raw.foldedKeys) &&
        isRecord(raw.config)
        ? (raw as unknown as H2W)
        : null;
    case 'ack':
      return typeof raw.seq === 'number' && typeof raw.version === 'number'
        ? { type: 'ack', seq: raw.seq, version: raw.version }
        : null;
    case 'refresh':
      return isRecord(raw.snapshot) &&
        typeof raw.version === 'number' &&
        (raw.cause === 'external' || raw.cause === 'undo' || raw.cause === 'conflict')
        ? (raw as unknown as H2W)
        : null;
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
