import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
  resolve: {
    alias: {
      // extension 层的 'vscode' 在测试里指向最小 API 桩（见 test/unit/mocks/vscode.ts）
      vscode: fileURLToPath(new URL('./test/unit/mocks/vscode.ts', import.meta.url)),
    },
  },
});
