// 折叠状态存储（规格见 docs/06-folding-and-mirrors.md）。
// 红线 3：折叠态只进 workspaceState，绝不写进用户的 markdown 文件。

/**
 * vscode.Memento 与 vscode.Uri 的最小结构约束——两者天然满足，
 * 因此本模块无需 import vscode，测试可直接注入假对象。
 */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface UriLike {
  toString(): string;
}

interface Entry {
  keys: string[];
  t: number; // 最近访问时间戳，用于 LRU
}

const PREFIX = 'folding:';
const INDEX_KEY = 'folding:index';
const MAX_FILES = 200;
const MAX_KEYS_PER_FILE = 2000;

export class FoldingStore {
  constructor(
    private readonly state: MementoLike,
    private readonly now: () => number = () => Date.now(),
  ) {}

  load(uri: UriLike): string[] {
    const entry = this.state.get<Entry>(PREFIX + uri.toString());
    return entry?.keys ?? [];
  }

  save(uri: UriLike, foldedKeys: string[]): void {
    const key = PREFIX + uri.toString();
    // SPEC-GAP: docs/06 说超出上限「丢弃最深层的」，但 nodeKey 不含深度信息。
    // webview 按文档先序上报，取前 N 个即等价于优先保留靠上/靠浅的节点。
    const keys = foldedKeys.slice(0, MAX_KEYS_PER_FILE);
    void this.state.update(key, { keys, t: this.now() } satisfies Entry);
    this.touchIndex(key);
  }

  /** 维护 LRU 索引，超过 MAX_FILES 时淘汰最旧的文件记录，防 Memento 膨胀。 */
  private touchIndex(key: string): void {
    const index = this.state.get<string[]>(INDEX_KEY) ?? [];
    const next = [key, ...index.filter((k) => k !== key)];
    const dropped = next.splice(MAX_FILES);
    for (const stale of dropped) void this.state.update(stale, undefined);
    void this.state.update(INDEX_KEY, next);
  }
}
