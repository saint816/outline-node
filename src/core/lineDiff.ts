// 最小编辑区间（规格见 docs/04-sync-protocol.md）。
// 单次 op 引起的文本变更总是局部连续的，因此按行裁掉公共前缀/后缀、中段作为
// 单个替换 span 即可，不需要通用 diff 算法。

export interface TextEditSpan {
  start: number; // 字符偏移，host 转 vscode.Range
  end: number;
  text: string;
}

export function minimalEdits(oldText: string, newText: string): TextEditSpan[] {
  if (oldText === newText) return [];

  const a = splitKeepEol(oldText);
  const b = splitKeepEol(newText);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  let start = 0;
  for (let i = 0; i < prefix; i++) start += a[i].length;

  let suffixLen = 0;
  for (let i = a.length - suffix; i < a.length; i++) suffixLen += a[i].length;

  const end = oldText.length - suffixLen;
  const text = newText.slice(start, newText.length - suffixLen);
  return [{ start, end, text }];
}

/**
 * 把 spans 应用回文本。
 * SPEC-GAP: docs 未定义此函数；恒等式测试与 host 侧 mock 都需要它，且是纯函数。
 * spans 由 minimalEdits 产出（互不重叠、按 start 升序）。
 */
export function applyEdits(text: string, spans: readonly TextEditSpan[]): string {
  let result = '';
  let cursor = 0;
  for (const span of spans) {
    result += text.slice(cursor, span.start) + span.text;
    cursor = span.end;
  }
  return result + text.slice(cursor);
}

/** 按行切分，行尾符保留在行内（"a\r\nb" → ["a\r\n", "b"]）。 */
function splitKeepEol(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}
