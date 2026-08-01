// 同步协议剧本测试（见 docs/09 第 2 节）——回归价值最高的一层。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentSession, type SessionHost } from '../../src/extension/documentSession.js';
import { FoldingStore, type MementoLike } from '../../src/extension/foldingStore.js';
import { applyEdits, type TextEditSpan } from '../../src/core/lineDiff.js';
import type { DocSnapshot, EditorConfig, H2W } from '../../src/shared/protocol.js';
import type { NodeSnapshot } from '../../src/shared/protocol.js';

const CONFIG: EditorConfig = {
  defaultIndent: { kind: 'space', width: 2 },
  defaultFold: 'none',
  rememberFolding: true,
};

class MockMemento implements MementoLike {
  readonly store = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.store.delete(key);
    else this.store.set(key, value);
    return Promise.resolve();
  }
}

class MockHost implements SessionHost {
  readonly uri = { toString: (): string => 'file:///test.outline.md' };
  version = 1;
  posted: H2W[] = [];
  applyEditSucceeds = true;
  editCalls = 0;
  undoCalls = 0;
  redoCalls = 0;
  onChange: (() => void) | null = null;
  beforeApplyEdit: Promise<void> | null = null;
  private history: string[] = [];

  constructor(private text: string) {}

  getText(): string {
    return this.text;
  }

  async applyEdit(spans: TextEditSpan[]): Promise<boolean> {
    this.editCalls++;
    if (!this.applyEditSucceeds) return false;
    await this.beforeApplyEdit;
    this.history.push(this.text);
    this.setText(applyEdits(this.text, spans));
    return true;
  }

  postMessage(msg: H2W): void {
    this.posted.push(msg);
  }

  executeUndo(): void {
    this.undoCalls++;
    const prev = this.history.pop();
    if (prev !== undefined) this.setText(prev);
  }

  executeRedo(): void {
    this.redoCalls++;
  }

  /** 模拟外部写文件 / Git checkout。 */
  external(text: string): void {
    this.history.push(this.text);
    this.setText(text);
  }

  private setText(text: string): void {
    this.text = text;
    this.version++;
    this.onChange?.();
  }
}

function setup(text: string, config: EditorConfig = CONFIG) {
  const host = new MockHost(text);
  const memento = new MockMemento();
  const session = new DocumentSession(host, new FoldingStore(memento), config);
  host.onChange = () => session.onDocumentChanged();
  return { host, session, memento };
}

function nodesOf(snapshot: DocSnapshot): NodeSnapshot[] {
  const out: NodeSnapshot[] = [];
  const walk = (nodes: NodeSnapshot[]): void => {
    for (const n of nodes) {
      out.push(n);
      walk(n.children);
    }
  };
  for (const block of snapshot.blocks) if (block.kind === 'list') walk(block.roots);
  return out;
}

function initMsg(posted: H2W[]): Extract<H2W, { type: 'init' }> {
  const msg = posted.find((m) => m.type === 'init');
  if (!msg || msg.type !== 'init') throw new Error('no init message');
  return msg;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ready / init', () => {
  it('回 init：快照的 raw 一律为 null，version 用 TextDocument.version', async () => {
    const { host, session } = setup('- a\n  - b\n');
    await session.handleMessage({ type: 'ready' });

    const init = initMsg(host.posted);
    expect(init.version).toBe(1);
    expect(init.config).toEqual(CONFIG);
    expect(init.foldedKeys).toEqual([]);
    expect(nodesOf(init.snapshot).map((n) => n.text)).toEqual(['a', 'b']);
    expect(nodesOf(init.snapshot).every((n) => n.raw === null)).toBe(true);
  });
});

describe('edit', () => {
  it('每条 edit 恰好一个 ack、无 refresh，文档文本按最小编辑写回', async () => {
    const { host, session } = setup('- a\n- b\n');
    await session.handleMessage({ type: 'ready' });
    const nodes = nodesOf(initMsg(host.posted).snapshot);

    await session.handleMessage({
      type: 'edit',
      baseVersion: 1,
      seq: 1,
      ops: [{ op: 'setText', id: nodes[0].id, text: 'A' }],
    });

    expect(host.getText()).toBe('- A\n- b\n');
    const acks = host.posted.filter((m) => m.type === 'ack');
    expect(acks).toEqual([{ type: 'ack', seq: 1, version: 2 }]);
    expect(host.posted.some((m) => m.type === 'refresh')).toBe(false);
  });

  it('连续 edit：逐条 ack，回声不触发 refresh', async () => {
    const { host, session } = setup('- a\n');
    await session.handleMessage({ type: 'ready' });
    const id = nodesOf(initMsg(host.posted).snapshot)[0].id;

    await session.handleMessage({ type: 'edit', baseVersion: 1, seq: 1, ops: [{ op: 'setText', id, text: 'ab' }] });
    await session.handleMessage({ type: 'edit', baseVersion: 2, seq: 2, ops: [{ op: 'setText', id, text: 'abc' }] });
    vi.advanceTimersByTime(500);

    expect(host.getText()).toBe('- abc\n');
    expect(host.posted.filter((m) => m.type === 'ack').map((m) => m.seq)).toEqual([1, 2]);
    expect(host.posted.some((m) => m.type === 'refresh')).toBe(false);
  });

  it('结构 op：split 写回正确的 markdown', async () => {
    const { host, session } = setup('- hello\n');
    await session.handleMessage({ type: 'ready' });
    const id = nodesOf(initMsg(host.posted).snapshot)[0].id;

    await session.handleMessage({
      type: 'edit',
      baseVersion: 1,
      seq: 1,
      ops: [{ op: 'split', id, offset: 2, newId: 'w-1' }],
    });
    expect(host.getText()).toBe('- he\n- llo\n');
  });

  it('全部 no-op → 直接 ack，不写文档', async () => {
    const { host, session } = setup('- a\n');
    await session.handleMessage({ type: 'ready' });

    await session.handleMessage({
      type: 'edit',
      baseVersion: 1,
      seq: 7,
      ops: [{ op: 'setText', id: 'ghost', text: 'x' }],
    });

    expect(host.editCalls).toBe(0);
    expect(host.posted.at(-1)).toEqual({ type: 'ack', seq: 7, version: 1 });
  });

  it('baseVersion 失配 → refresh{cause:"conflict"}，ops 被丢弃', async () => {
    const { host, session } = setup('- a\n');
    await session.handleMessage({ type: 'ready' });
    const id = nodesOf(initMsg(host.posted).snapshot)[0].id;

    host.external('- a\n- 外部新增\n');
    vi.advanceTimersByTime(200);
    host.posted.length = 0;

    // webview 还拿着旧的 baseVersion
    await session.handleMessage({
      type: 'edit',
      baseVersion: 1,
      seq: 3,
      ops: [{ op: 'setText', id, text: '不该生效' }],
    });

    expect(host.posted).toHaveLength(1);
    expect(host.posted[0]).toMatchObject({ type: 'refresh', cause: 'conflict' });
    expect(host.getText()).toBe('- a\n- 外部新增\n');
  });

  it('applyEdit 返回 false → refresh{cause:"conflict"}，mirrorDoc 与文本重新对齐', async () => {
    const { host, session } = setup('- a\n');
    await session.handleMessage({ type: 'ready' });
    const id = nodesOf(initMsg(host.posted).snapshot)[0].id;

    host.applyEditSucceeds = false;
    await session.handleMessage({ type: 'edit', baseVersion: 1, seq: 1, ops: [{ op: 'setText', id, text: 'A' }] });

    const refresh = host.posted.at(-1);
    expect(refresh).toMatchObject({ type: 'refresh', cause: 'conflict' });
    expect(host.getText()).toBe('- a\n');

    // mirrorDoc 已回到文本状态：同一个 id 上再来一次编辑能正常生效
    host.applyEditSucceeds = true;
    const survived = nodesOf((refresh as Extract<H2W, { type: 'refresh' }>).snapshot)[0].id;
    await session.handleMessage({
      type: 'edit',
      baseVersion: host.version,
      seq: 2,
      ops: [{ op: 'setText', id: survived, text: 'A' }],
    });
    expect(host.getText()).toBe('- A\n');
  });
});

describe('外部修改', () => {
  it('外部改文件 → 一条 refresh{cause:"external"}，旧 id 存活', async () => {
    const { host, session } = setup('- a\n- b\n');
    await session.handleMessage({ type: 'ready' });
    const before = nodesOf(initMsg(host.posted).snapshot);
    host.posted.length = 0;

    host.external('- a\n- b\n- c\n');
    vi.advanceTimersByTime(100);

    const refreshes = host.posted.filter((m) => m.type === 'refresh');
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]).toMatchObject({ cause: 'external', version: 2 });
    const after = nodesOf((refreshes[0] as Extract<H2W, { type: 'refresh' }>).snapshot);
    expect(after.map((n) => n.text)).toEqual(['a', 'b', 'c']);
    expect(after[0].id).toBe(before[0].id); // treeMatch 复用旧 id → 折叠/光标存活
    expect(after[1].id).toBe(before[1].id);
  });

  it('连续外部写只处理最后一次（防抖 100ms）', async () => {
    const { host, session } = setup('- a\n');
    await session.handleMessage({ type: 'ready' });
    host.posted.length = 0;

    host.external('- a1\n');
    vi.advanceTimersByTime(40);
    host.external('- a2\n');
    vi.advanceTimersByTime(40);
    host.external('- a3\n');
    vi.advanceTimersByTime(100);

    const refreshes = host.posted.filter((m) => m.type === 'refresh');
    expect(refreshes).toHaveLength(1);
    expect(
      nodesOf((refreshes[0] as Extract<H2W, { type: 'refresh' }>).snapshot).map((n) => n.text),
    ).toEqual(['a3']);
  });
});

describe('undo / redo 转发', () => {
  it('外部刷新后的 edit 与紧随其后的 requestUndo 串行，保留外部内容', async () => {
    const { host, session } = setup('- [ ] task\n');
    await session.handleMessage({ type: 'ready' });

    host.external('- [ ] task\n- external keep\n');
    await vi.advanceTimersByTimeAsync(100);
    const refresh = host.posted.at(-1);
    expect(refresh).toMatchObject({ type: 'refresh', cause: 'external' });
    const id = nodesOf((refresh as Extract<H2W, { type: 'refresh' }>).snapshot)[0].id;

    let releaseEdit!: () => void;
    host.beforeApplyEdit = new Promise<void>((resolve) => {
      releaseEdit = resolve;
    });
    const edit = session.handleMessage({
      type: 'edit',
      baseVersion: host.version,
      seq: 1,
      ops: [{ op: 'toggleChecked', id }],
    });
    await Promise.resolve();
    const undo = session.handleMessage({ type: 'requestUndo' });

    // applyEdit 尚未完成时，Undo 不能越过它去撤销更早的外部变更。
    expect(host.undoCalls).toBe(0);
    releaseEdit();
    await edit;
    await undo;
    await vi.advanceTimersByTimeAsync(100);

    expect(host.undoCalls).toBe(1);
    expect(host.getText()).toBe('- [ ] task\n- external keep\n');
    expect(host.posted.at(-1)).toMatchObject({ type: 'refresh', cause: 'undo' });
  });

  it('requestUndo → executeUndo → 文档变化 → refresh{cause:"undo"}', async () => {
    const { host, session } = setup('- a\n');
    await session.handleMessage({ type: 'ready' });
    const id = nodesOf(initMsg(host.posted).snapshot)[0].id;
    await session.handleMessage({ type: 'edit', baseVersion: 1, seq: 1, ops: [{ op: 'setText', id, text: 'A' }] });
    host.posted.length = 0;

    await session.handleMessage({ type: 'requestUndo' });
    vi.advanceTimersByTime(100);

    expect(host.undoCalls).toBe(1);
    expect(host.getText()).toBe('- a\n');
    expect(host.posted.filter((m) => m.type === 'refresh')).toMatchObject([{ cause: 'undo' }]);
  });

  it('undo 之后的下一次外部修改 cause 回到 external', async () => {
    const { host, session } = setup('- a\n');
    await session.handleMessage({ type: 'ready' });
    await session.handleMessage({ type: 'requestUndo' });
    vi.advanceTimersByTime(100);
    host.posted.length = 0;

    host.external('- 外部\n');
    vi.advanceTimersByTime(100);
    expect(host.posted.filter((m) => m.type === 'refresh')).toMatchObject([{ cause: 'external' }]);
  });

  it('requestRedo 转发到 executeRedo', async () => {
    const { host, session } = setup('- a\n');
    await session.handleMessage({ type: 'requestRedo' });
    expect(host.redoCalls).toBe(1);
  });
});

describe('折叠状态', () => {
  it('saveFolding 落 workspaceState，dispose 时再保存一次', async () => {
    const { host, session, memento } = setup('- a\n');
    await session.handleMessage({ type: 'saveFolding', foldedKeys: ['h:abc', 'b:k1'] });

    const key = 'folding:' + host.uri.toString();
    expect(memento.get<{ keys: string[] }>(key)?.keys).toEqual(['h:abc', 'b:k1']);

    session.dispose();
    expect(memento.get<{ keys: string[] }>(key)?.keys).toEqual(['h:abc', 'b:k1']);
  });

  it('rememberFolding = false 时不落盘，init 下发空数组', async () => {
    const { host, session, memento } = setup('- a\n', { ...CONFIG, rememberFolding: false });
    await session.handleMessage({ type: 'saveFolding', foldedKeys: ['h:abc'] });
    await session.handleMessage({ type: 'ready' });

    expect(memento.store.size).toBe(0);
    expect(initMsg(host.posted).foldedKeys).toEqual([]);
  });

  it('init 下发已保存的 foldedKeys', async () => {
    const { host, session, memento } = setup('- a\n');
    memento.store.set('folding:' + host.uri.toString(), { keys: ['h:xyz'], t: 0 });
    await session.handleMessage({ type: 'ready' });
    expect(initMsg(host.posted).foldedKeys).toEqual(['h:xyz']);
  });
});

describe('dispose', () => {
  it('dispose 后不再响应消息与文档事件', async () => {
    const { host, session } = setup('- a\n');
    session.dispose();
    await session.handleMessage({ type: 'ready' });
    host.external('- b\n');
    vi.advanceTimersByTime(200);
    expect(host.posted).toEqual([]);
  });
});
