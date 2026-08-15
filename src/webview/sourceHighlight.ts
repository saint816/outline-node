// 聚焦编辑时的 Markdown 源码高亮。使用 CSS Custom Highlight API，只标 Range，
// 不往 contenteditable 里插 span，因此不改变光标偏移，也不触碰 IME 组合 DOM。

const NAMES = ['outline-md-syntax', 'outline-md-code', 'outline-md-bold', 'outline-md-mark', 'outline-md-link'];

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

export class SourceHighlighter {
  private active: HTMLElement | null = null;

  sync(el: HTMLElement): void {
    if (el.dataset.field !== 'text') return;
    this.clear();
    const registry = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
    const HighlightCtor = (globalThis as unknown as {
      Highlight?: new (...ranges: Range[]) => unknown;
    }).Highlight;
    const textNode = el.firstChild;
    if (!registry || !HighlightCtor || !textNode || textNode.nodeType !== Node.TEXT_NODE) return;

    const text = textNode.textContent ?? '';
    const ranges = new Map<string, Range[]>();
    const add = (name: string, start: number, end: number): void => {
      if (start >= end) return;
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, end);
      const bucket = ranges.get(name);
      if (bucket) bucket.push(range);
      else ranges.set(name, [range]);
    };

    scan(text, /\[([^\]]*)\]\(([^)\n]*)\)/g, (m) => {
      add('outline-md-link', m.index, m.index + m[0].length);
      const closeLabel = m.index + 1 + m[1].length;
      add('outline-md-syntax', m.index, m.index + 1);
      add('outline-md-syntax', closeLabel, closeLabel + 2);
      add('outline-md-syntax', m.index + m[0].length - 1, m.index + m[0].length);
    });
    scan(text, /`([^`\n]+)`/g, (m) => {
      add('outline-md-code', m.index, m.index + m[0].length);
      add('outline-md-syntax', m.index, m.index + 1);
      add('outline-md-syntax', m.index + m[0].length - 1, m.index + m[0].length);
    });
    scan(text, /\*\*([^*\n]+)\*\*/g, (m) => {
      add('outline-md-bold', m.index, m.index + m[0].length);
      add('outline-md-syntax', m.index, m.index + 2);
      add('outline-md-syntax', m.index + m[0].length - 2, m.index + m[0].length);
    });
    scan(text, /==([^=\n]+)==/g, (m) => {
      add('outline-md-mark', m.index, m.index + m[0].length);
      add('outline-md-syntax', m.index, m.index + 2);
      add('outline-md-syntax', m.index + m[0].length - 2, m.index + m[0].length);
    });

    if (ranges.size === 0) return;
    for (const [name, list] of ranges) registry.set(name, new HighlightCtor(...list));
    el.classList.add('source-highlighting');
    this.active = el;
  }

  clear(el?: HTMLElement): void {
    if (el !== undefined && this.active !== el) return;
    const registry = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
    if (registry) for (const name of NAMES) registry.delete(name);
    this.active?.classList.remove('source-highlighting');
    this.active = null;
  }
}

function scan(text: string, pattern: RegExp, visit: (match: RegExpExecArray) => void): void {
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) visit(match);
}
