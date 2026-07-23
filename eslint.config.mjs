import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'out/**',
      '*.vsix',
      '.vscode-test/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // 红线 6：src/core/ 零依赖——不得 import vscode，不得使用 DOM API。
    files: ['src/core/**/*.ts', 'src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: ['vscode'], patterns: ['**/extension/**', '**/webview/**'] }],
      'no-restricted-globals': [
        'error',
        'document',
        'window',
        'HTMLElement',
        'navigator',
        'location',
        'localStorage',
      ],
    },
  },
  {
    files: ['test/**/*.ts', 'test/**/*.mjs', 'esbuild.mjs', 'vitest.config.ts'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // 集成测试用例由 VS Code 以 CommonJS require 加载
    files: ['test/integration/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
