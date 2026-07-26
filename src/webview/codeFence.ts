// 围栏代码块的解析与渲染，顶层代码块（文档级 RawBlock）与节点代码块（节点的 note）共用。
// 两条路径唯一的差别是 textarea 的 data-field：'code' 走 setRawBlock，'noteCode' 走 setNote。

import { canHighlight, renderHighlight } from './highlight.js';
import { t } from './i18n.js';

const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})(.*)$/;

export interface CodeFence {
  lang: string;
  code: string;
  /** 原始开围栏行（保留字节） */
  open: string;
  /** 原始闭围栏行；未闭合时 null */
  close: string | null;
}

/** 首行是围栏时抽出语言、正文与原始首尾围栏行；否则 null。 */
export function parseFence(lines: string[]): CodeFence | null {
  if (lines.length < 1) return null;
  const open = FENCE_OPEN_RE.exec(lines[0]);
  if (!open) return null;
  const fence = open[1][0]; // '`' 或 '~'
  const lang = open[2].trim().split(/\s+/)[0] ?? '';
  const closeRe = new RegExp('^[ \\t]*' + fence + '{3,}[ \\t]*$');
  const closed = lines.length > 1 && closeRe.test(lines[lines.length - 1]);
  const body = lines.slice(1, closed ? lines.length - 1 : lines.length);
  return {
    lang,
    code: body.join('\n'),
    open: lines[0],
    close: closed ? lines[lines.length - 1] : null,
  };
}

/** 新建一个空代码块的 note 文本。刻意不留空正文行——那会被序列化成缩进空白行。 */
export function emptyFence(lang: string): string {
  return '```' + lang + '\n```';
}

/** textarea 内容 + 元素上记着的原始围栏行 → 完整的块文本行。 */
export function fenceLinesFrom(el: HTMLElement, body: string): string[] {
  const open = el.dataset.codeOpen ?? '```';
  const lines = [open, ...body.split('\n')];
  if ('codeClose' in el.dataset) lines.push(el.dataset.codeClose as string);
  return lines;
}

/** 把围栏渲染进容器：语言徽标 + 可编辑 textarea（原始围栏行记在 dataset 上）。 */
export function renderFence(el: HTMLElement, fence: CodeFence, field: 'code' | 'noteCode'): void {
  el.dataset.codeOpen = fence.open;
  if (fence.close !== null) el.dataset.codeClose = fence.close;
  else delete el.dataset.codeClose;

  const sig = fence.lang + ' ' + fence.code;
  if (el.dataset.codeSig === sig) return; // 内容没变就不重建，避免打断输入 / 闪烁
  el.dataset.codeSig = sig;

  // 头部：语言选择按钮 + 复制按钮。绝对定位在代码块右上角，**不占布局高度**——
  // 让它占一行会把「块排进节点行」的成果顶掉，代码块上方又多出一条空行（实机反馈）。
  const head = document.createElement('div');
  head.className = 'code-head';
  const label = document.createElement('button');
  label.type = 'button';
  label.className = 'code-lang';
  label.dataset.action = 'pick-lang';
  label.dataset.lang = fence.lang;
  label.textContent = fence.lang === '' ? t('code.plain') : fence.lang;
  label.title = t('code.pickLang');
  label.setAttribute('aria-label', t('code.pickLang'));
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'code-copy';
  copy.dataset.action = 'copy-code';
  copy.textContent = t('code.copy');
  copy.setAttribute('aria-label', t('code.copy'));
  head.append(label, copy);

  // 正文：高亮层（只读、aria-hidden）压在透明文字的 textarea 之下，两层字体/内边距必须一致
  const body = document.createElement('div');
  body.className = 'code-body';
  const area = document.createElement('textarea');
  area.className = 'code-input';
  area.dataset.field = field;
  area.spellcheck = false;
  area.wrap = 'off';
  area.value = fence.code;
  area.rows = Math.max(1, fence.code.split('\n').length);

  if (canHighlight(fence.lang)) {
    const hl = document.createElement('pre');
    hl.className = 'code-hl';
    hl.setAttribute('aria-hidden', 'true');
    renderHighlight(hl, fence.code, fence.lang);
    body.append(hl);
    el.classList.add('highlighted');
  } else {
    el.classList.remove('highlighted');
  }
  body.append(area, head);
  el.replaceChildren(body);
}

/** 打字热路径：只重画高亮层，不重建代码块 DOM（重建会打断输入）。 */
export function syncHighlight(block: HTMLElement, code: string): void {
  const hl = block.querySelector<HTMLElement>('.code-hl');
  if (hl === null) return;
  // 语言取 dataset 而不是徽标文字：徽标上的「纯文本 / text」是本地化文案，不是语言 id
  renderHighlight(hl, code, block.querySelector<HTMLElement>('.code-lang')?.dataset.lang ?? '');
}
