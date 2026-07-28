import * as vscode from 'vscode';
import type { TextEditSpan } from '../core/lineDiff.js';
import { asW2H, type EditorConfig, type H2W, type W2H } from '../shared/protocol.js';
import { DocumentSession, type SessionHost } from './documentSession.js';
import type { FoldingStore } from './foldingStore.js';
import type { BookmarkStore } from './bookmarkStore.js';
import { autoPruneOrphanImages } from './imageCleanup.js';

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
        if (!msg) return;
        // 图片写盘要真 vscode.fs + 文档 uri，属 provider 职责；DocumentSession 保持 vscode 无关。
        if (msg.type === 'saveImage') {
          void saveImageFile(document, webview, msg);
          return;
        }
        if (msg.type === 'openLink') {
          // 只放行 http(s)/mailto：webview 传来的字符串不可信，别让它触发任意 scheme
          // （vscode:、file: 等能被用来做本地操作）
          const uri = safeExternalUri(msg.url);
          if (uri) void vscode.env.openExternal(uri);
          else void vscode.window.showErrorMessage(vscode.l10n.t('OutlineNode: Unsupported link.'));
          return;
        }
        if (msg.type === 'copyText') {
          // 走宿主剪贴板：webview 里的 navigator.clipboard / execCommand 在 VS Code 下
          // 有过静默失败的前科（见 docs/11），复制这种「按了没反应」最难查
          void vscode.env.clipboard.writeText(msg.text);
          return;
        }
        void session.handleMessage(msg);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== document.uri.toString()) return;
        if (e.contentChanges.length === 0) return;
        session.onDocumentChanged();
      }),
      // 保存后清理孤儿图片：删节点只是可 undo 的文本编辑，删文件不是——延到保存给 undo
      // 留出窗口，且只动扩展自己生成的 pasted-*、移废纸篓（见 imageCleanup.ts 顶部）。
      vscode.workspace.onDidSaveTextDocument((saved) => {
        if (saved.uri.toString() !== document.uri.toString()) return;
        const on = vscode.workspace
          .getConfiguration('outlineNode')
          .get<boolean>('cleanupUnusedImagesOnSave');
        if (on === false) return;
        void autoPruneOrphanImages(document, assetsDirFor(document.uri));
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
    // 粘贴图片的落盘目录（相对文档）：`<文件名>/assets`，别把图片撒在笔记同级目录里。
    const assetsDir = assetsDirFor(document.uri);
    // 键位随平台变（见 webview/platform.ts）：UA 嗅探在 webview / 测试环境都不可靠，由 host 注入
    const platform = process.platform === 'darwin' ? 'mac' : 'other';
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="${lang}" data-doc-base="${docBase}" data-assets-dir="${escapeAttr(assetsDir)}" data-platform="${platform}">
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

/**
 * 粘贴图片的落盘目录（相对文档所在目录）：`<文件名去扩展名>/assets`。
 * `notes.outline.md` → `notes/assets`。所有权清晰，孤儿清理才敢只在这个目录里动手。
 */
export function assetsDirFor(uri: vscode.Uri): string {
  const base = uri.path.split('/').pop() ?? '';
  const name = base.replace(/\.md$/i, '').replace(/\.outline$/i, '');
  return (name === '' ? 'assets' : name + '/assets');
}

// webview 生成的名字形如 `<dir>/pasted-<ts>-<rand>.<ext>`：逐段白名单，挡住路径穿越。
const SAFE_SEGMENT = /^[^/\\:*?"<>|]+$/;

function safeRelativePath(name: string): string[] | null {
  const segments = name.split('/');
  if (segments.length === 0 || segments.length > 4) return null;
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..' || !SAFE_SEGMENT.test(seg)) return null;
  }
  return segments;
}

/** 只允许 http / https / mailto 的外部链接；其余一律拒绝（见 handleMessage 处注释）。 */
export function safeExternalUri(raw: string): vscode.Uri | null {
  try {
    const uri = vscode.Uri.parse(raw, true);
    return ['http', 'https', 'mailto'].includes(uri.scheme.toLowerCase()) ? uri : null;
  } catch {
    return null;
  }
}

async function saveImageFile(
  document: vscode.TextDocument,
  webview: vscode.Webview,
  msg: Extract<W2H, { type: 'saveImage' }>,
): Promise<void> {
  const segments = safeRelativePath(msg.name);
  if (!segments) {
    void vscode.window.showErrorMessage(vscode.l10n.t('OutlineNode: Invalid image name.'));
    return;
  }
  const target = vscode.Uri.joinPath(document.uri, '..', ...segments);
  try {
    if (segments.length > 1) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'));
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(msg.dataBase64, 'base64'));
    void webview.postMessage({ type: 'imageSaved', name: msg.name } satisfies H2W);
  } catch {
    void vscode.window.showErrorMessage(vscode.l10n.t('OutlineNode: Failed to save pasted image.'));
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
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
