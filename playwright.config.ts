import { defineConfig, devices } from '@playwright/test';

// webview DOM 测试（见 docs/09 第 3 节）：普通浏览器页面直接加载 dist/webview.js，
// mock acquireVsCodeApi，驱动真实键盘/IME 事件。
export default defineConfig({
  testDir: './test',
  testMatch: ['webview/**/*.spec.ts', 'perf/**/*.spec.ts'],
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    ...devices['Desktop Chrome'],
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
