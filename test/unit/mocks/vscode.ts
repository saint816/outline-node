// 最小 vscode API 桩：vitest 通过 resolve.alias 把 'vscode' 指到这里，
// 让 extension 层（provider / session 接线）能在纯 Node 下跑端到端剧本。

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  constructor(
    readonly start: Position,
    readonly end: Position,
  ) {}
}

export class Uri {
  private constructor(private readonly value: string) {}
  static parse(value: string): Uri {
    return new Uri(value);
  }
  /** 真 vscode.Uri 有 path（scheme/authority 之后的部分）。 */
  get path(): string {
    const withoutScheme = this.value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
    const slash = withoutScheme.indexOf('/');
    return slash === -1 ? '/' : withoutScheme.slice(slash);
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri([base.toString(), ...parts].join('/'));
  }
  toString(): string {
    return this.value;
  }
}

export interface TextDocumentLike {
  uri: Uri;
  version: number;
  getText(): string;
  positionAt(offset: number): Position;
  offsetAt(position: Position): number;
}

export class MockTextDocument implements TextDocumentLike {
  version = 1;
  constructor(
    readonly uri: Uri,
    private text: string,
  ) {}

  getText(): string {
    return this.text;
  }

  positionAt(offset: number): Position {
    const before = this.text.slice(0, offset);
    const lines = before.split('\n');
    return new Position(lines.length - 1, lines[lines.length - 1].length);
  }

  offsetAt(position: Position): number {
    const lines = this.text.split('\n');
    let offset = 0;
    for (let i = 0; i < position.line && i < lines.length; i++) offset += lines[i].length + 1;
    return offset + position.character;
  }

  /** 供 mock 的 applyEdit / 外部修改使用。 */
  setText(text: string): void {
    this.text = text;
    this.version++;
    fireDocumentChange(this);
  }
}

interface EditEntry {
  uri: Uri;
  range: Range;
  text: string;
}

export class WorkspaceEdit {
  readonly entries: EditEntry[] = [];
  replace(uri: Uri, range: Range, text: string): void {
    this.entries.push({ uri, range, text });
  }
}

// ---------- 事件 ----------

type ChangeListener = (e: { document: TextDocumentLike; contentChanges: unknown[] }) => void;
const saveListeners = new Set<(doc: TextDocumentLike) => void>();
const changeListeners = new Set<ChangeListener>();

function fireDocumentChange(document: TextDocumentLike): void {
  for (const listener of [...changeListeners]) listener({ document, contentChanges: [{}] });
}

/** 触发一次「文档已保存」（自动清理孤儿图片挂在这个事件上）。 */
export function fireDocumentSave(document: TextDocumentLike): void {
  for (const listener of [...saveListeners]) listener(document);
}

export interface Disposable {
  dispose(): void;
}

// ---------- 命名空间 ----------

export const registry = {
  customEditors: [] as { viewType: string; provider: unknown }[],
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  executed: [] as { command: string; args: unknown[] }[],
  config: new Map<string, unknown>(),
  /** 测试可替换：模拟 applyEdit 失败。 */
  applyEditSucceeds: true,
  documents: [] as MockTextDocument[],
  /** workspace.fs.writeFile 的记录（图片写盘测试用）。 */
  writes: [] as { uri: string; bytes: Uint8Array }[],
  createdDirs: [] as string[],
  deletes: [] as { uri: string; useTrash: boolean }[],
  /** readDirectory 的桩数据：目录 uri → 文件名列表。 */
  dirs: new Map<string, string[]>(),
  /** window.showErrorMessage 的记录。 */
  errors: [] as string[],
  reset(): void {
    this.customEditors = [];
    this.commands.clear();
    this.executed = [];
    this.config.clear();
    this.applyEditSucceeds = true;
    this.documents = [];
    this.writes = [];
    this.errors = [];
    changeListeners.clear();
    saveListeners.clear();
    this.createdDirs = [];
    this.deletes = [];
    this.dirs.clear();
    window.activeTextEditor = undefined;
    window.tabGroups.activeTabGroup.activeTab = undefined;
  },
};

export const workspace = {
  onDidChangeTextDocument(listener: ChangeListener): Disposable {
    changeListeners.add(listener);
    return { dispose: () => changeListeners.delete(listener) };
  },
  onDidSaveTextDocument(listener: (doc: TextDocumentLike) => void): Disposable {
    saveListeners.add(listener);
    return { dispose: () => saveListeners.delete(listener) };
  },
  openTextDocument(uri: Uri): Promise<TextDocumentLike | undefined> {
    return Promise.resolve(registry.documents.find((d) => d.uri.toString() === uri.toString()));
  },
  applyEdit(edit: WorkspaceEdit): Promise<boolean> {
    if (!registry.applyEditSucceeds) return Promise.resolve(false);
    for (const entry of edit.entries) {
      const doc = registry.documents.find((d) => d.uri.toString() === entry.uri.toString());
      if (!doc) return Promise.resolve(false);
      const start = doc.offsetAt(entry.range.start);
      const end = doc.offsetAt(entry.range.end);
      doc.setText(doc.getText().slice(0, start) + entry.text + doc.getText().slice(end));
    }
    return Promise.resolve(true);
  },
  getConfiguration(_section: string) {
    return {
      get<T>(key: string): T | undefined {
        return registry.config.get(key) as T | undefined;
      },
    };
  },
  getWorkspaceFolder(_uri: Uri): { uri: Uri } | undefined {
    return undefined;
  },
  fs: {
    createDirectory(uri: Uri): Promise<void> {
      registry.createdDirs.push(uri.toString());
      return Promise.resolve();
    },
    writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      registry.writes.push({ uri: uri.toString(), bytes: content });
      return Promise.resolve();
    },
    readDirectory(uri: Uri): Promise<[string, number][]> {
      const entries = registry.dirs.get(uri.toString());
      if (!entries) return Promise.reject(new Error('ENOENT'));
      return Promise.resolve(entries.map((name) => [name, FileType.File] as [string, number]));
    },
    delete(uri: Uri, options?: { useTrash?: boolean }): Promise<void> {
      registry.deletes.push({ uri: uri.toString(), useTrash: options?.useTrash === true });
      return Promise.resolve();
    },
  },
};

export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;

export const env = {
  language: 'en',
};

export const l10n = {
  t(message: string): string {
    return message;
  },
};

export class TabInputCustom {
  constructor(
    readonly uri: Uri,
    readonly viewType: string,
  ) {}
}

export const window = {
  statusBarMessages: [] as string[],
  setStatusBarMessage(message: string, _hideAfterTimeout?: number): Disposable {
    window.statusBarMessages.push(message);
    return { dispose: () => {} };
  },
  activeTextEditor: undefined as { document: TextDocumentLike } | undefined,
  tabGroups: {
    activeTabGroup: { activeTab: undefined as { input: unknown } | undefined },
  },
  registerCustomEditorProvider(viewType: string, provider: unknown): Disposable {
    registry.customEditors.push({ viewType, provider });
    return { dispose: () => {} };
  },
  showInformationMessage(): Promise<undefined> {
    return Promise.resolve(undefined);
  },
  showErrorMessage(message: string): Promise<undefined> {
    registry.errors.push(message);
    return Promise.resolve(undefined);
  },
};

export const commands = {
  registerCommand(command: string, callback: (...args: unknown[]) => unknown): Disposable {
    registry.commands.set(command, callback);
    return { dispose: () => {} };
  },
  executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    registry.executed.push({ command, args });
    return Promise.resolve(undefined);
  },
};
