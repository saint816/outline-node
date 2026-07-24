import * as vscode from 'vscode';
import type { TextEditSpan } from '../core/lineDiff.js';
import { asW2H, type EditorConfig, type H2W } from '../shared/protocol.js';
import { DocumentSession, type SessionHost } from './documentSession.js';
import type { FoldingStore } from './foldingStore.js';
import type { BookmarkStore } from './bookmarkStore.js';

/**
 * CustomTextEditorProvider：webview 创建、HTML/CSP、session 生命周期。
 * 业务消息一律转交 DocumentSession（见 docs/01 模块职责表）。
 */
export class OutlineEditorProvider implements vscode.CustomTextEditorProvider {
  /** uri → 该文档当前的 session。集成测试用它注入编辑消息（见 docs/09 第 4 节）。 */
  readonly sessions = new Map<string, DocumentSession>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly folding: FoldingStore,
    private readonly readConfig: () => EditorConfig,
    private readonly bookmarks?: BookmarkStore,
  ) {}

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): void {
    const webview = webviewPanel.webview;
    // 图片渲染（见 docs/05）：webview 只能加载 localResourceRoots 白名单里的本地文件。
    // 允许扩展 dist、文档所在目录、以及所属工作区，让 `![[x]]` / `![](x)` 能引用到图片。
    const resourceRoots = [
      vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
      vscode.Uri.joinPath(document.uri, '..'),
    ];
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (workspaceFolder) resourceRoots.push(workspaceFolder.uri);
    webview.options = {
      enableScripts: true,
      localResourceRoots: resourceRoots,
    };
    webview.html = this.buildHtml(webview, document);

    const session = new DocumentSession(
      createSessionHost(document, webview),
      this.folding,
      this.readConfig(),
      this.bookmarks,
    );
    this.sessions.set(document.uri.toString(), session);

    const subscriptions = [
      webview.onDidReceiveMessage((raw: unknown) => {
        const msg = asW2H(raw);
        if (msg) void session.handleMessage(msg);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== document.uri.toString()) return;
        if (e.contentChanges.length === 0) return;
        session.onDocumentChanged();
      }),
    ];

    webviewPanel.onDidDispose(() => {
      if (this.sessions.get(document.uri.toString()) === session) {
        this.sessions.delete(document.uri.toString());
      }
      session.dispose();
      for (const sub of subscriptions) sub.dispose();
    });
  }

  private buildHtml(webview: vscode.Webview, document: vscode.TextDocument): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'),
    );
    // i18n：把 VS Code 显示语言注入 <html lang>，webview 的 i18n 据此选目录（无需协议往返）。
    const lang = vscode.env.language || 'en';
    // 图片：文档所在目录的 webview URI，供 webview 把相对路径改写成可加载的 vscode-webview:// 地址。
    const docBase = webview.asWebviewUri(vscode.Uri.joinPath(document.uri, '..')).toString();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="${lang}" data-doc-base="${docBase}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>Outline</title>
</head>
<body>
<div id="outline-root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function createSessionHost(document: vscode.TextDocument, webview: vscode.Webview): SessionHost {
  return {
    uri: document.uri,
    get version(): number {
      return document.version;
    },
    getText: () => document.getText(),
    applyEdit: async (spans: TextEditSpan[]): Promise<boolean> => {
      const edit = new vscode.WorkspaceEdit();
      for (const span of spans) {
        const range = new vscode.Range(
          document.positionAt(span.start),
          document.positionAt(span.end),
        );
        edit.replace(document.uri, range, span.text);
      }
      return vscode.workspace.applyEdit(edit);
    },
    postMessage: (msg: H2W) => {
      void webview.postMessage(msg);
    },
    // undo/redo 完全交给 VS Code：CustomTextEditorProvider 免费提供 TextDocument 的
    // undo 栈，本项目一行都不自己实现（红线 5）
    executeUndo: async () => {
      await vscode.commands.executeCommand('undo');
    },
    executeRedo: async () => {
      await vscode.commands.executeCommand('redo');
    },
  };
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += chars[Math.floor(Math.random() * chars.length)];
  return nonce;
}
