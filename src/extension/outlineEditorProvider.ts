import * as vscode from 'vscode';
import type { M0Host2Webview, M0Webview2Host } from '../shared/m0Skeleton.js';

/**
 * CustomTextEditorProvider：webview HTML / CSP / 生命周期。
 *
 * M0 骨架版：webview 只读显示文档全文。M2 起改为创建 DocumentSession 并把业务消息
 * 全部转交 session（本类不处理业务消息，见 docs/01 模块职责表）。
 */
export class OutlineEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

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

    const post = (): void => {
      const msg: M0Host2Webview = { type: 'text', text: document.getText() };
      void webview.postMessage(msg);
    };

    const subscriptions = [
      webview.onDidReceiveMessage((msg: M0Webview2Host) => {
        if (msg.type === 'ready') post();
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === document.uri.toString()) post();
      }),
    ];

    webviewPanel.onDidDispose(() => {
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

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += chars[Math.floor(Math.random() * chars.length)];
  return nonce;
}
