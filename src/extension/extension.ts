import * as vscode from 'vscode';
import type { IndentUnit } from '../core/model.js';
import type { EditorConfig } from '../shared/protocol.js';
import type { DocumentSession } from './documentSession.js';
import { FoldingStore } from './foldingStore.js';
import { BookmarkStore } from './bookmarkStore.js';
import { OutlineEditorProvider } from './outlineEditorProvider.js';

const VIEW_TYPES = ['outlineNode.outline', 'outlineNode.outlineOptional'] as const;

/** 扩展导出的 API：目前只服务集成测试，不对用户暴露命令。 */
export interface OutlineNodeApi {
  getSession(uri: string): DocumentSession | undefined;
}

export function activate(context: vscode.ExtensionContext): OutlineNodeApi {
  const folding = new FoldingStore(context.workspaceState);
  const bookmarks = new BookmarkStore(context.workspaceState);

  // customEditors 的 priority 按 entry 生效，因此两个 viewType 注册到同一个 provider（见 docs/01）
  const provider = new OutlineEditorProvider(context, folding, readEditorConfig, bookmarks);
  for (const viewType of VIEW_TYPES) {
    context.subscriptions.push(
      vscode.window.registerCustomEditorProvider(viewType, provider, {
        webviewOptions: { retainContextWhenHidden: false },
        supportsMultipleEditorsPerDocument: true,
      }),
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('outlineNode.openAsOutline', async () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (!uri) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('OutlineNode: No active text editor.'),
        );
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', uri, 'outlineNode.outlineOptional');
    }),
  );

  return { getSession: (uri) => provider.sessions.get(uri) };
}

export function deactivate(): void {
  // 无全局资源需要释放：每个 panel 的 session 与订阅随 panel dispose。
}

export function readEditorConfig(): EditorConfig {
  const config = vscode.workspace.getConfiguration('outlineNode');
  return {
    defaultIndent: toIndentUnit(config.get<string>('defaultIndent') ?? '2-space'),
    defaultFold: config.get<'none' | 'firstLevel'>('defaultFold') ?? 'none',
    rememberFolding: config.get<boolean>('rememberFolding') ?? true,
  };
}

function toIndentUnit(value: string): IndentUnit {
  switch (value) {
    case 'tab':
      return { kind: 'tab' };
    case '4-space':
      return { kind: 'space', width: 4 };
    default:
      return { kind: 'space', width: 2 };
  }
}
