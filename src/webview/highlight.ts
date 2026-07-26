// 代码块语法高亮。Prism 打进 bundle（CSP 只放行 webview 自己的资源，绝不能外链 CDN）。
//
// ⚠️ 语言集是有代价的，不要随手加：实测每多打包一批语法，5000 节点的「外部 refresh patch」
// 就更接近 50ms 红线（见 docs/07）。16 门全装时 5 次采样全部 ≥49ms、均值 52.4ms —— 破线；
// 现在这套（core 自带 markup/css/javascript/clike + 下面 8 个）均值 45.5ms，与不装 Prism 的
// 基线（46.9ms）无差别。要再加语言，必须先按 docs/09 单独串行跑 perf 复测。
//
// 高亮层是 textarea 背后的一层 <pre>：textarea 文字透明、只留光标，两层用同一套字体
// 与 padding 严格对齐。不这么做就得放弃「编辑时也有高亮」——textarea 内部无法着色。
import Prism from 'prismjs';
import 'prismjs/components/prism-typescript.js';
import 'prismjs/components/prism-json.js';
import 'prismjs/components/prism-python.js';
import 'prismjs/components/prism-bash.js';
import 'prismjs/components/prism-go.js';
import 'prismjs/components/prism-rust.js';
import 'prismjs/components/prism-sql.js';
import 'prismjs/components/prism-yaml.js';
// 说明：Prism core 自带 markup(html/xml/svg)、css、clike、javascript，无需单独 import。

/** 围栏里常见的别名 → Prism 语言 id。命中不了就退化成纯文本，不报错。 */
const ALIASES: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  yml: 'yaml',
  golang: 'go',
  rs: 'rust',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',
}

/** 语言选择菜单里可选的语言（值 = 写进围栏行的字符串，空串 = 纯文本）。 */
export const LANGUAGES: readonly { id: string; label: string }[] = [
  { id: '', label: 'Plain text' },
  { id: 'js', label: 'JavaScript' },
  { id: 'ts', label: 'TypeScript' },
  { id: 'json', label: 'JSON' },
  { id: 'python', label: 'Python' },
  { id: 'bash', label: 'Shell' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'sql', label: 'SQL' },
  { id: 'yaml', label: 'YAML' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
];

/** 该语言能否高亮（决定是否值得建高亮层）。 */
export function canHighlight(lang: string): boolean {
  return grammarOf(lang) !== null;
}

function grammarOf(lang: string): Prism.Grammar | null {
  const key = lang.trim().toLowerCase();
  if (key === '') return null;
  const id = ALIASES[key] ?? key;
  return (Prism.languages as Record<string, Prism.Grammar | undefined>)[id] ?? null;
}

/**
 * 把代码渲染进高亮层。语言不认识就走纯文本（textContent，天然转义）。
 * 末尾补一个换行：否则最后一行是空行时 <pre> 会比 textarea 矮一行，两层错位。
 */
export function renderHighlight(el: HTMLElement, code: string, lang: string): void {
  const grammar = grammarOf(lang);
  if (grammar === null) {
    el.textContent = code + '\n';
    return;
  }
  el.innerHTML = Prism.highlight(code, grammar, (ALIASES[lang.toLowerCase()] ?? lang).toLowerCase()) + '\n';
}
