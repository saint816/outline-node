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

  // 大纲 ↔ 原生文本 双向切换。命令既能从编辑器标题栏 / 命令面板触发（uri 缺省时自解析
  // 当前编辑器），也能从资源管理器右键触发（VS Code 把点中的资源作为首个实参传入）。
  const reopenWith = (viewType: string) => async (resource?: vscode.Uri) => {
    const uri = resource ?? activeDocumentUri();
    if (!uri) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('OutlineNode: No active Markdown file.'),
      );
      return;
    }
    await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'outlineNode.openAsOutline',
      reopenWith('outlineNode.outlineOptional'),
    ),
    // 'default' = VS Code 内置文本编辑器
    vscode.commands.registerCommand('outlineNode.openAsText', reopenWith('default')),
  );

  return { getSession: (uri) => provider.sessions.get(uri) };
}

export function deactivate(): void {
  // 无全局资源需要释放：每个 panel 的 session 与订阅随 panel dispose。
}

/**
 * 当前编辑器对应的文档 uri。原生文本编辑器走 activeTextEditor；大纲是 webview 自定义
 * 编辑器，activeTextEditor 为空，改从活动 tab 的 TabInputCustom 取 uri。
 */
function activeDocumentUri(): vscode.Uri | undefined {
  const textUri = vscode.window.activeTextEditor?.document.uri;
  if (textUri) return textUri;
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom) return input.uri;
  return undefined;
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
