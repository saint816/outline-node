// 图片解析与 URI 解析（Phase 2）。
// 只认真正的图片嵌入：Markdown `![alt](path)` 与 Obsidian `![[file.ext]]`。
// 排除镜像块引用 `![[#^id]]`（那是 block ref，见 docs/06）。
// 相对路径按文档所在目录解析——docBase 由 host 注入到 <html data-doc-base>（buildHtml）。
// 局限：Obsidian 的 `![[img]]` 是全库解析，这里只按「相对当前文件目录」解析（见 docs/05）。

const DOC_BASE = (document.documentElement.dataset.docBase ?? '').replace(/\/$/, '');
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;

export interface ParsedImage {
  src: string;
  alt: string;
}

const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g; // ![alt](path)
const WIKI_IMAGE_RE = /!\[\[([^\]]+)\]\]/g; // ![[target]]

/** 抽出一行文本里的所有图片；无图返回空数组。 */
export function parseImages(text: string): ParsedImage[] {
  const out: ParsedImage[] = [];
  for (const m of text.matchAll(MD_IMAGE_RE)) {
    out.push({ alt: m[1], src: resolveSrc(m[2]) });
  }
  for (const m of text.matchAll(WIKI_IMAGE_RE)) {
    const target = m[1];
    if (target.startsWith('#')) continue; // 块引用 / 镜像
    if (!looksLikeImage(target)) continue; // ![[某笔记]] 之类的非图嵌入
    out.push({ alt: fileName(target), src: resolveSrc(target) });
  }
  return out;
}

/** 整行恰好是一张图（前后可有空白）时返回它，否则 null——用于独立成行的图片块。 */
export function wholeLineImage(line: string): ParsedImage | null {
  const trimmed = line.trim();
  const md = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(trimmed);
  if (md) return { alt: md[1], src: resolveSrc(md[2]) };
  const wiki = /^!\[\[([^\]]+)\]\]$/.exec(trimmed);
  if (wiki && !wiki[1].startsWith('#') && looksLikeImage(wiki[1])) {
    return { alt: fileName(wiki[1]), src: resolveSrc(wiki[1]) };
  }
  return null;
}

function looksLikeImage(target: string): boolean {
  return IMAGE_EXT.test(stripSuffix(target));
}

/** Obsidian 允许 `![[img.png|200]]` 的宽度后缀，取 `|` 前的路径。 */
function stripSuffix(target: string): string {
  return target.split('|')[0].trim();
}

function fileName(target: string): string {
  return stripSuffix(target);
}

function resolveSrc(rawPath: string): string {
  const path = stripSuffix(rawPath).replace(/^\.\//, '');
  if (/^(https?:|data:|vscode-webview:|file:)/i.test(path)) return path;
  if (DOC_BASE === '') return path;
  return DOC_BASE + '/' + encodePath(path);
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}
