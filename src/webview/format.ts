// 选区加/去行内标记的纯逻辑（`code`、**bold**、==mark==、[text](url)）。
// 纯函数、不碰 DOM，逻辑靠单测覆盖——DOM 里试错太贵。
//
// 语义遵循「再按一次取消」：选区已经被这对标记包住（无论标记在选区内还是选区外）就去掉，
// 否则加上。返回新文本与新选区，调用方负责写回 store + 重设选区。

export type Marker = '**' | '==' | '`';

export interface FormatResult {
  text: string;
  /** 施加后应当选中的范围（选中的仍是「内容」，不含标记） */
  start: number;
  end: number;
}

export interface LinkValue {
  title: string;
  url: string;
}

/** 选区恰好是一条完整 Markdown 链接时拆出标题与地址。 */
export function parseLink(text: string): LinkValue | null {
  const match = /^\[([^\]]*)\]\(([^)\n]*)\)$/.exec(text);
  return match ? { title: match[1], url: match[2] } : null;
}

/** 用链接编辑框给定的标题与地址替换当前选区。 */
export function setLink(text: string, start: number, end: number, value: LinkValue): FormatResult {
  const [from, to] = start <= end ? [start, end] : [end, start];
  const link = `[${value.title}](${value.url})`;
  const caret = from + link.length;
  return { text: text.slice(0, from) + link + text.slice(to), start: caret, end: caret };
}

/** 选区两侧紧邻标记（`**abc**` 里选中 `abc`）→ 去掉标记。 */
function unwrapOutside(text: string, start: number, end: number, marker: Marker): FormatResult | null {
  const before = text.slice(Math.max(0, start - marker.length), start);
  const after = text.slice(end, end + marker.length);
  if (before !== marker || after !== marker) return null;
  const head = text.slice(0, start - marker.length);
  const body = text.slice(start, end);
  return { text: head + body + text.slice(end + marker.length), start: head.length, end: head.length + body.length };
}

/** 选区自身就是 `**abc**` → 去掉标记。 */
function unwrapInside(text: string, start: number, end: number, marker: Marker): FormatResult | null {
  const body = text.slice(start, end);
  if (body.length < marker.length * 2) return null;
  if (!body.startsWith(marker) || !body.endsWith(marker)) return null;
  const inner = body.slice(marker.length, body.length - marker.length);
  return { text: text.slice(0, start) + inner + text.slice(end), start, end: start + inner.length };
}

/**
 * 给 [start, end) 加上 / 去掉一对标记。
 * 选区为空时插入一对空标记并把光标放中间（跟大多数编辑器一致，直接开始打字即可）。
 */
export function toggleMarker(text: string, start: number, end: number, marker: Marker): FormatResult {
  const [from, to] = start <= end ? [start, end] : [end, start];
  return (
    unwrapOutside(text, from, to, marker) ??
    unwrapInside(text, from, to, marker) ?? {
      text: text.slice(0, from) + marker + text.slice(from, to) + marker + text.slice(to),
      start: from + marker.length,
      end: to + marker.length,
    }
  );
}

/**
 * 把选区变成链接 `[选中的字](url)`；已经是链接则还原成纯文字。
 * url 为空时留空括号，光标落到括号里等着粘地址。
 */
export function toggleLink(text: string, start: number, end: number, url = ''): FormatResult {
  const [from, to] = start <= end ? [start, end] : [end, start];
  const body = text.slice(from, to);

  // 选区正好是一个完整链接：给了新 url 就换地址（粘贴覆盖），没给就还原成纯文字（再按一次取消）
  const whole = parseLink(body);
  if (whole) {
    const label = whole.title;
    if (url !== '') {
      const next = `[${label}](${url})`;
      const caret = from + next.length;
      return { text: text.slice(0, from) + next + text.slice(to), start: caret, end: caret };
    }
    return { text: text.slice(0, from) + label + text.slice(to), start: from, end: from + label.length };
  }

  const head = `${text.slice(0, from)}[${body}](`;
  // 没给 url：光标停在括号里等着粘地址；给了：光标落到整条链接之后，接着往下打字
  const caret = url === '' ? head.length : head.length + url.length + 1;
  return { text: `${head}${url})${text.slice(to)}`, start: caret, end: caret };
}

/**
 * 剪贴板文本是不是「一眼就是个链接」——用来决定选中文字时粘贴要不要自动包成 [文字](url)。
 * 刻意从严：必须是单个 token、且带 http(s)/mailto 协议或 www. 前缀。宁可漏判走普通粘贴，
 * 也不要把一段普通文字误当链接吞掉用户的选中内容。
 */
export function looksLikeUrl(text: string): boolean {
  const s = text.trim();
  if (s === '' || /\s/.test(s)) return false;
  return /^(?:https?:\/\/|mailto:)\S+$/i.test(s) || /^www\.[^.\s]+\.\S+$/i.test(s);
}
