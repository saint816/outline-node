import * as vscode from 'vscode';
import { OutlineEditorProvider } from './outlineEditorProvider.js';

const VIEW_TYPES = ['outlineNode.outline', 'outlineNode.outlineOptional'] as const;

export function activate(context: vscode.ExtensionContext): void {
  // customEditors 的 priority 按 entry 生效，因此两个 viewType 注册到同一个 provider（见 docs/01）
  const provider = new OutlineEditorProvider(context);
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
        void vscode.window.showInformationMessage('OutlineNode: 没有活动的文本编辑器。');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', uri, 'outlineNode.outlineOptional');
    }),
  );
}

export function deactivate(): void {
  // 无全局资源需要释放：每个 panel 的订阅在 provider 内随 panel dispose。
}
