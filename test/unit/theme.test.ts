// 主题适配核查（M5）：样式里禁止硬编码颜色，一律走 --vscode-* 变量（见 docs/05）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  fileURLToPath(new URL('../../src/webview/styles.css', import.meta.url)),
  'utf8',
);

/** forced-colors 区块用的是系统颜色关键字（Highlight/CanvasText），不算硬编码。 */
const SYSTEM_COLORS = ['Highlight', 'CanvasText', 'Canvas', 'ButtonText'];

describe('样式主题适配', () => {
  it('没有硬编码的 hex / rgb / hsl 颜色', () => {
    const offenders = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g)].map((m) => m[0]);
    expect(offenders).toEqual([]);
  });

  it('没有硬编码的具名颜色（系统颜色关键字除外）', () => {
    const named = ['white', 'black', 'red', 'blue', 'green', 'gray', 'grey', 'yellow'];
    const offenders = named.filter((color) =>
      new RegExp(`:\\s*${color}\\b|,\\s*${color}\\b`, 'i').test(css),
    );
    expect(offenders).toEqual([]);
  });

  it('颜色相关声明都引用 --vscode-* 变量或系统颜色', () => {
    const declarations = [...css.matchAll(/(?:^|\n)\s*(color|background|background-color|border-color|outline|box-shadow|border|border-left-color)\s*:\s*([^;]+);/g)];
    const bad = declarations
      .map(([, prop, value]) => `${prop}: ${value.trim()}`)
      .filter((decl) => {
        const value = decl.split(':').slice(1).join(':');
        if (value.includes('--vscode-')) return false;
        if (SYSTEM_COLORS.some((c) => value.includes(c))) return false;
        // none / transparent / inherit / 纯宽度写法（如 1px solid transparent）不涉及颜色
        return !/^\s*(none|transparent|inherit|initial|unset|0|[\d.]+px\s+solid\s+transparent)\s*$/.test(
          value,
        );
      });
    expect(bad).toEqual([]);
  });

  it('高对比度与减少动效各有一段媒体查询', () => {
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
