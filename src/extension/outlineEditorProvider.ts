import * as vscode from 'vscode';
import type { TextEditSpan } from '../core/lineDiff.js';
import { asW2H, type EditorConfig, type H2W } from '../shared/protocol.js';
import { DocumentSession, type SessionHost } from './documentSession.js';
import type { FoldingStore } from './foldingStore.js';

/**
 * CustomTextEditorProvider：webview 创建、HTML/CSP、session 生命周期。
 * 业务消息一律转交 DocumentSession（见 docs/01 模块职责表）。
 */
export class OutlineEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly folding: FoldingStore,
    private readonly readConfig: () => EditorConfig,
  ) {}

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): void {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    webview.html = this.buildHtml(webview);

    const session = new DocumentSession(
      createSessionHost(document, webview),
      this.folding,
      this.readConfig(),
    );

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
      session.dispose();
      for (const sub of subscriptions) sub.dispose();
    });
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'),
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
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
