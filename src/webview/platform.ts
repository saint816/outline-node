// 运行平台（host 在 buildHtml 里注入 <html data-platform>）。
// 刻意不嗅探 navigator.userAgent：VS Code webview 与 Playwright 里它都可能是别的平台
// （实测 Playwright 的 Chromium 在 macOS 上报 Windows UA），键位判定会整片错掉。

export function isMac(): boolean {
  return document.documentElement.dataset.platform === 'mac';
}
