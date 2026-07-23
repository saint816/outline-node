// 红线 6：src/core/ 零依赖——不得 import vscode，不得使用 DOM API。
// ESLint 也有一层强制（eslint.config.mjs 的 no-restricted-imports / no-restricted-globals），
// 这里再钉一道测试，保证 `npm test` 单独就能守住。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CORE_DIR = join(fileURLToPath(new URL('../../', import.meta.url)), 'src', 'core');

const files = readdirSync(CORE_DIR).filter((f) => f.endsWith('.ts'));

/** 去掉注释与字符串字面量，避免中文注释里的「document」误报。 */
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

describe('core 纯度', () => {
  it('存在 core 源文件', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file}：无 vscode / DOM 依赖`, () => {
      const code = stripCommentsAndStrings(readFileSync(join(CORE_DIR, file), 'utf8'));
      expect(code).not.toMatch(/from\s+['"]vscode['"]/);
      expect(code).not.toMatch(/require\(\s*['"]vscode['"]\s*\)/);
      expect(code).not.toMatch(/\b(document|window|navigator|localStorage)\s*\./);
      expect(code).not.toMatch(/\bHTMLElement\b/);
      // core 不得反向依赖 extension / webview
      expect(code).not.toMatch(/from\s+['"][^'"]*(extension|webview)\//);
    });
  }
});
