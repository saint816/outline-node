// 围栏代码块的解析与渲染，顶层代码块（文档级 RawBlock）与节点代码块（节点的 note）共用。
// 两条路径唯一的差别是 textarea 的 data-field：'code' 走 setRawBlock，'noteCode' 走 setNote。

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

  const parts: HTMLElement[] = [];
  if (fence.lang) {
    const label = document.createElement('span');
    label.className = 'code-lang';
    label.textContent = fence.lang;
    parts.push(label);
  }
  const area = document.createElement('textarea');
  area.className = 'code-input';
  area.dataset.field = field;
  area.spellcheck = false;
  area.wrap = 'off';
  area.value = fence.code;
  area.rows = Math.max(1, fence.code.split('\n').length);
  parts.push(area);
  el.replaceChildren(...parts);
}
