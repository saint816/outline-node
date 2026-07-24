// 星标书签存储（UI-state）。套用 foldingStore 的模板：只进 workspaceState，
// 绝不写进用户的 markdown 文件（红线 3）。书签存 nodeKey（跨 session 稳定，见 docs/06）。

import type { MementoLike, UriLike } from './foldingStore.js';

interface Entry {
  keys: string[];
  t: number; // 最近访问时间戳，用于 LRU
}

const PREFIX = 'bookmarks:';
const INDEX_KEY = 'bookmarks:index';
const MAX_FILES = 200;
const MAX_KEYS_PER_FILE = 500;

export class BookmarkStore {
  constructor(
    private readonly state: MementoLike,
    private readonly now: () => number = () => Date.now(),
  ) {}

  load(uri: UriLike): string[] {
    return this.state.get<Entry>(PREFIX + uri.toString())?.keys ?? [];
  }

  save(uri: UriLike, bookmarkKeys: string[]): void {
    const key = PREFIX + uri.toString();
    const keys = bookmarkKeys.slice(0, MAX_KEYS_PER_FILE);
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
