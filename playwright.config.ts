import { defineConfig, devices } from '@playwright/test';

// webview DOM 测试（见 docs/09 第 3 节）：普通浏览器页面直接加载 dist/webview.js，
// mock acquireVsCodeApi，驱动真实键盘/IME 事件。
export default defineConfig({
  testDir: './test',
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    ...devices['Desktop Chrome'],
  },
  projects: [
    {
      name: 'chromium',
      testMatch: ['webview/**/*.spec.ts'],
      fullyParallel: true,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // 性能基准量的是墙钟时间，和功能测试抢核会把「patch < 50ms」这条挤爆。
      // 单独一个 project、单 worker 串行跑，且排在功能测试之后。
      name: 'perf',
      testMatch: ['perf/**/*.spec.ts'],
      fullyParallel: false,
      workers: 1,
      dependencies: ['chromium'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
