// extension 层接线的端到端剧本：provider 建 session、WorkspaceEdit 的 span→Range 换算、
// 文档事件回流。用最小 vscode 桩（test/unit/mocks/vscode.ts）在纯 Node 下跑。
import { beforeEach, describe, expect, it } from 'vitest';
// 直接引 mock 模块：vitest 的 alias 让 src/extension 里的 'vscode' 解析到同一份实例
import {
  MockTextDocument,
  TabInputCustom,
  Uri,
  fireDocumentSave,
  registry,
  window as mockWindow,
} from './mocks/vscode.js';
import { activate, readEditorConfig } from '../../src/extension/extension.js';
import { OutlineEditorProvider } from '../../src/extension/outlineEditorProvider.js';
import { FoldingStore } from '../../src/extension/foldingStore.js';
import type { H2W, W2H } from '../../src/shared/protocol.js';
import type { NodeSnapshot } from '../../src/shared/protocol.js';

interface Harness {
  document: MockTextDocument;
  posted: H2W[];
  send(msg: W2H): Promise<void>;
  html(): string;
  dispose(): void;
}

function openEditor(initialText: string): Harness {
  const uri = Uri.parse('file:///notes/a.outline.md');
  const document = new MockTextDocument(uri, initialText);
  registry.documents.push(document);

  const posted: H2W[] = [];
  let onMessage: ((raw: unknown) => void) | null = null;
  let onDispose: (() => void) | null = null;

  const webview = {
    cspSource: 'vscode-webview://test',
    options: {},
    html: '',
    asWebviewUri: (u: unknown) => u,
    onDidReceiveMessage(listener: (raw: unknown) => void) {
      onMessage = listener;
      return { dispose: () => {} };
    },
    postMessage(msg: H2W) {
      posted.push(msg);
      return Promise.resolve(true);
    },
  };
  const panel = {
    webview,
    onDidDispose(listener: () => void) {
      onDispose = listener;
      return { dispose: () => {} };
    },
  };

  const context = { subscriptions: [], extensionUri: Uri.parse('file:///ext'), workspaceState: memento() };
  const provider = new OutlineEditorProvider(
    context as never,
    new FoldingStore(memento()),
    readEditorConfig,
  );
  provider.resolveCustomTextEditor(document as never, panel as never, {} as never);

  return {
    document,
    posted,
    send: async (msg: W2H) => {
      onMessage?.(msg);
      // handleMessage 是 async：让微任务队列跑完
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    html: () => webview.html,
    dispose: () => onDispose?.(),
  };
}

function memento() {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
    update: (key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

function nodes(msg: H2W): NodeSnapshot[] {
  if (msg.type !== 'init' && msg.type !== 'refresh') return [];
  const out: NodeSnapshot[] = [];
  const walk = (list: NodeSnapshot[]): void => {
    for (const n of list) {
      out.push(n);
      walk(n.children);
    }
  };
  for (const block of msg.snapshot.blocks) if (block.kind === 'list') walk(block.roots);
  return out;
}

beforeEach(() => {
  registry.reset();
});

describe('activate', () => {
  it('两个 viewType 注册到同一个 provider 实例，命令可用', () => {
    const context = { subscriptions: [], extensionUri: Uri.parse('file:///ext'), workspaceState: memento() };
    activate(context as never);

    expect(registry.customEditors.map((e) => e.viewType)).toEqual([
      'outlineNode.outline',
      'outlineNode.outlineOptional',
    ]);
    expect(registry.customEditors[0].provider).toBe(registry.customEditors[1].provider);
    expect([...registry.commands.keys()]).toEqual([
      'outlineNode.openAsOutline',
      'outlineNode.openAsText',
      'outlineNode.cleanupImages',
    ]);
  });

  it('openAsOutline 对活动文本编辑器执行 vscode.openWith', async () => {
    const context = { subscriptions: [], extensionUri: Uri.parse('file:///ext'), workspaceState: memento() };
    activate(context as never);
    const uri = Uri.parse('file:///notes/b.md');
    mockWindow.activeTextEditor = { document: new MockTextDocument(uri, '') };

    await registry.commands.get('outlineNode.openAsOutline')!();
    expect(registry.executed).toEqual([
      { command: 'vscode.openWith', args: [uri, 'outlineNode.outlineOptional'] },
    ]);
  });

  it('openAsText 在大纲编辑器里（无 activeTextEditor）从活动 tab 取 uri 切回原生文本', async () => {
    const context = { subscriptions: [], extensionUri: Uri.parse('file:///ext'), workspaceState: memento() };
    activate(context as never);
    const uri = Uri.parse('file:///notes/c.md');
    // 大纲是自定义编辑器：activeTextEditor 为空，uri 来自活动 tab 的 TabInputCustom
    mockWindow.tabGroups.activeTabGroup.activeTab = {
      input: new TabInputCustom(uri, 'outlineNode.outlineOptional'),
    };

    await registry.commands.get('outlineNode.openAsText')!();
    expect(registry.executed).toEqual([{ command: 'vscode.openWith', args: [uri, 'default'] }]);
  });

  it('资源管理器右键：命令用传入的资源 uri，而非活动编辑器', async () => {
    const context = { subscriptions: [], extensionUri: Uri.parse('file:///ext'), workspaceState: memento() };
    activate(context as never);
    const clicked = Uri.parse('file:///notes/picked.md');
    // 另开一个不相关的活动编辑器，确认命令优先用传入的资源实参
    mockWindow.activeTextEditor = { document: new MockTextDocument(Uri.parse('file:///other.md'), '') };

    await registry.commands.get('outlineNode.openAsOutline')!(clicked);
    expect(registry.executed).toEqual([
      { command: 'vscode.openWith', args: [clicked, 'outlineNode.outlineOptional'] },
    ]);
  });

  it('读取配置：defaultIndent 字符串映射为 IndentUnit', () => {
    registry.config.set('defaultIndent', 'tab');
    registry.config.set('defaultFold', 'firstLevel');
    registry.config.set('rememberFolding', false);
    expect(readEditorConfig()).toEqual({
      defaultIndent: { kind: 'tab' },
      defaultFold: 'firstLevel',
      rememberFolding: false,
    });
  });
});

describe('provider ↔ session 端到端', () => {
  it('webview HTML：CSP 严格，脚本带 nonce，无内联脚本', () => {
    const html = openEditor('- a\n').html();
    expect(html).toContain("default-src 'none'");
    const nonce = /script-src 'nonce-([A-Za-z0-9]{32})'/.exec(html)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonce}"`);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toMatch(/webview\.js/);
    expect(html).toMatch(/webview\.css/);
  });

  it('saveImage：把 base64 写到文档同目录并回 imageSaved', async () => {
    const harness = openEditor('- a\n');
    const dataBase64 = Buffer.from('PNG-BYTES').toString('base64');
    await harness.send({ type: 'saveImage', name: 'pasted-1.png', dataBase64 });

    expect(registry.writes).toHaveLength(1);
    expect(registry.writes[0].uri).toContain('pasted-1.png');
    expect(Buffer.from(registry.writes[0].bytes).toString()).toBe('PNG-BYTES');
    expect(harness.posted.some((m) => m.type === 'imageSaved' && m.name === 'pasted-1.png')).toBe(
      true,
    );
  });

  // 复制按钮走宿主剪贴板：webview 里的 navigator.clipboard / execCommand 有静默失败前科
  it('copyText：写进 VS Code 剪贴板，不碰文档', async () => {
    const harness = openEditor('- a\n');
    await harness.send({ type: 'copyText', text: 'const n = 42;' });

    expect(registry.clipboard).toEqual(['const n = 42;']);
    expect(registry.writes).toHaveLength(0);
    expect(harness.document.getText()).toBe('- a\n');
  });

  // 链接来自 webview 里的文本，是不可信输入：只放行 http/https/mailto，
  // 否则 vscode:、file: 这类 scheme 能被用来触发本地操作
  it('openLink：http/https/mailto 交给 openExternal，其余 scheme 拒绝', async () => {
    const harness = openEditor('- a\n');
    await harness.send({ type: 'openLink', url: 'https://example.com/a' });
    await harness.send({ type: 'openLink', url: 'mailto:a@b.c' });
    expect(registry.opened).toEqual(['https://example.com/a', 'mailto:a@b.c']);

    registry.opened = [];
    for (const url of ['vscode://x', 'file:///etc/passwd', 'javascript:alert(1)', '不是链接']) {
      await harness.send({ type: 'openLink', url });
    }
    expect(registry.opened).toEqual([]);
    expect(registry.errors).toHaveLength(4);
  });

  it('saveImage：带目录的名字先建目录再写盘（图片进 <文件名>/assets/）', async () => {
    const harness = openEditor('- a\n');
    const dataBase64 = Buffer.from('PNG').toString('base64');
    await harness.send({ type: 'saveImage', name: 'a/assets/pasted-2.png', dataBase64 });

    expect(registry.createdDirs.length).toBe(1);
    expect(registry.writes).toHaveLength(1);
    expect(registry.writes[0].uri).toContain('a/assets/pasted-2.png');
    expect(harness.posted.some((m) => m.type === 'imageSaved' && m.name === 'a/assets/pasted-2.png')).toBe(true);
  });

  // 「删掉图片节点后图片资源还在」的修复：清理挂在**保存**上（给 undo 留窗口），
  // 只动扩展自己生成的 pasted-*，且走废纸篓（三道可逆保障，见 imageCleanup.ts）。
  it('保存后自动清理：未被引用的 pasted-* 进废纸篓，仍被引用的与用户自带文件不动', async () => {
    const harness = openEditor('- 还留着 ![[a/assets/pasted-1-keep.png]]\n');
    registry.dirs.set('file:///notes/a.outline.md/../a/assets', [
      'pasted-1-keep.png', // 仍被引用 → 留
      'pasted-2-gone.png', // 已无引用 → 删
      'my-photo.png', // 用户自己放的（非 pasted-*）→ 不碰
      'notes.txt', // 非图片 → 不碰
    ]);

    fireDocumentSave(harness.document);
    await new Promise((r) => setTimeout(r, 0));

    expect(registry.deletes.map((d) => d.uri.split('/').pop())).toEqual(['pasted-2-gone.png']);
    expect(registry.deletes[0].useTrash).toBe(true); // 可恢复
  });

  it('设置关掉后保存不清理任何文件', async () => {
    const harness = openEditor('- 空\n');
    registry.config.set('cleanupUnusedImagesOnSave', false);
    registry.dirs.set('file:///notes/a.outline.md/../a/assets', ['pasted-9-gone.png']);

    fireDocumentSave(harness.document);
    await new Promise((r) => setTimeout(r, 0));

    expect(registry.deletes).toHaveLength(0);
  });

  it('saveImage：拒绝路径穿越的文件名，不写盘、报错', async () => {
    const harness = openEditor('- a\n');
    await harness.send({ type: 'saveImage', name: '../evil.png', dataBase64: 'AAAA' });

    expect(registry.writes).toHaveLength(0);
    expect(registry.errors.length).toBeGreaterThan(0);
    expect(harness.posted.some((m) => m.type === 'imageSaved')).toBe(false);
  });

  it('ready → init 快照，edit → 文档文本按期望 markdown 写回并 ack', async () => {
    const harness = openEditor('- alpha\n  - beta\n');
    await harness.send({ type: 'ready' });

    const init = harness.posted[0];
    expect(init.type).toBe('init');
    const [alpha, beta] = nodes(init);
    expect([alpha.text, beta.text]).toEqual(['alpha', 'beta']);

    await harness.send({
      type: 'edit',
      baseVersion: 1,
      seq: 1,
      ops: [{ op: 'setText', id: beta.id, text: 'BETA' }],
    });

    expect(harness.document.getText()).toBe('- alpha\n  - BETA\n');
    expect(harness.posted.at(-1)).toEqual({ type: 'ack', seq: 1, version: 2 });
  });

  it('结构 op 写回的 markdown 精确匹配', async () => {
    const harness = openEditor('- a\n- b\n');
    await harness.send({ type: 'ready' });
    const [a, b] = nodes(harness.posted[0]);

    await harness.send({ type: 'edit', baseVersion: 1, seq: 1, ops: [{ op: 'indent', id: b.id }] });
    expect(harness.document.getText()).toBe('- a\n  - b\n');

    await harness.send({
      type: 'edit',
      baseVersion: 2,
      seq: 2,
      ops: [{ op: 'split', id: a.id, offset: 1, newId: 'n1' }],
    });
    expect(harness.document.getText()).toBe('- a\n  - b\n- \n');
  });

  it('外部修改文档 → refresh 推给 webview（真实事件路径）', async () => {
    const harness = openEditor('- a\n');
    await harness.send({ type: 'ready' });
    harness.posted.length = 0;

    harness.document.setText('- a\n- 外部\n');
    await new Promise((resolve) => setTimeout(resolve, 200));

    const refresh = harness.posted.filter((m) => m.type === 'refresh');
    expect(refresh).toHaveLength(1);
    expect(refresh[0]).toMatchObject({ cause: 'external' });
    expect(nodes(refresh[0]).map((n) => n.text)).toEqual(['a', '外部']);
  });

  it('requestUndo 转发成 VS Code 的 undo 命令', async () => {
    const harness = openEditor('- a\n');
    await harness.send({ type: 'ready' });
    await harness.send({ type: 'requestUndo' });
    expect(registry.executed.map((e) => e.command)).toEqual(['undo']);
  });

  it('applyEdit 失败 → conflict refresh，文档不变', async () => {
    const harness = openEditor('- a\n');
    await harness.send({ type: 'ready' });
    const [a] = nodes(harness.posted[0]);
    registry.applyEditSucceeds = false;

    await harness.send({
      type: 'edit',
      baseVersion: 1,
      seq: 1,
      ops: [{ op: 'setText', id: a.id, text: 'A' }],
    });

    expect(harness.document.getText()).toBe('- a\n');
    expect(harness.posted.at(-1)).toMatchObject({ type: 'refresh', cause: 'conflict' });
  });

  it('CRLF 文档：写回保持 CRLF', async () => {
    const harness = openEditor('- a\r\n- b\r\n');
    await harness.send({ type: 'ready' });
    const [, b] = nodes(harness.posted[0]);

    await harness.send({
      type: 'edit',
      baseVersion: 1,
      seq: 1,
      ops: [{ op: 'setText', id: b.id, text: 'B' }],
    });
    expect(harness.document.getText()).toBe('- a\r\n- B\r\n');
  });

  it('非列表内容（frontmatter/正文）在编辑后字节不变', async () => {
    const text = '---\ntitle: t\n---\n\n# 标题\n\n- a\n  - b\n\n结尾。\n';
    const harness = openEditor(text);
    await harness.send({ type: 'ready' });
    const [, b] = nodes(harness.posted[0]);

    await harness.send({
      type: 'edit',
      baseVersion: 1,
      seq: 1,
      ops: [{ op: 'setText', id: b.id, text: 'B' }],
    });
    expect(harness.document.getText()).toBe(text.replace('  - b', '  - B'));
  });
});
