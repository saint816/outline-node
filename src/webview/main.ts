// webview bootstrap。
// M0 骨架版：只读显示文档全文。M2 起接入 store / renderer / keymap 等模块。
import './styles.css';
import type { M0Host2Webview, M0Webview2Host } from '../shared/m0Skeleton.js';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const root = document.getElementById('outline-root')!;
const pre = document.createElement('pre');
pre.className = 'outline-raw';
root.appendChild(pre);

window.addEventListener('message', (event: MessageEvent<M0Host2Webview>) => {
  const msg = event.data;
  if (msg.type === 'text') pre.textContent = msg.text;
});

const ready: M0Webview2Host = { type: 'ready' };
vscode.postMessage(ready);
