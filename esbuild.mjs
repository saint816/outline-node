// esbuild 双入口构建（见 docs/01-architecture.md）
//   src/extension/extension.ts → dist/extension.js  (cjs / node / external vscode)
//   src/webview/main.ts        → dist/webview.js + dist/webview.css  (iife / browser)
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  target: 'es2022',
  logLevel: 'info',
  minify: production,
  sourcemap: production ? false : 'inline',
};

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  ...common,
  entryPoints: ['src/extension/extension.ts'],
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  external: ['vscode'],
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  ...common,
  entryPoints: ['src/webview/main.ts'],
  outfile: 'dist/webview.js',
  format: 'iife',
  platform: 'browser',
  loader: { '.css': 'css' },
};

const configs = [extensionConfig, webviewConfig];

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[esbuild] watching…');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
  console.log('[esbuild] build complete');
}
