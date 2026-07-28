// 行内 Markdown 的「显示态 / 源码态」渲染：`code`、**加粗**、==高亮==、链接。
//
// 机制与图片一致（见 05）：**数据层永远只存原始 Markdown**，这里只做渲染。
//   - 未聚焦的节点 → 显示态：标记（`` ` ``、`**`、`==`、`[]()`）隐藏，只留排版效果；
//   - 聚焦的节点   → 源码态：还原成纯文本单 text node，编辑、光标、IME 全走老路。
//
// 为什么必须回源码态：contenteditable 里若让用户在「标记被隐藏」的文本上打字，
// 光标偏移与源文本偏移就对不上了，setText 会写错位置。回源码态是最省心也最不会错的解法
// （Obsidian 实况编辑同理）。副作用是点进去会看到标记，这是刻意的。
//
// 渲染用 DOM API 逐个建元素，不用 innerHTML —— 文本天然转义，杜绝注入。

/** 一次扫描认这些记号；顺序即优先级（代码最高，代码内不再解析其它记号）。 */
const INLINE_RE = new RegExp(
  [
    '(`+)([^`]+?)\\1', // `code`
    '!?\\[\\[[^\\]]*\\]\\]', // ![[wiki]] / [[wiki]]：交给图片/镜像层，这里原样跳过
    '\\[([^\\]]+)\\]\\(([^)\\s]+)\\)', // [text](url)
    '<((?:https?|mailto):[^>\\s]+)>', // <https://…>
    '(?:https?://|www\\.)[^\\s<>()\\[\\]"\'`]+', // 裸链接
    '\\*\\*([^*]+?)\\*\\*', // **bold**
    '==([^=]+?)==', // ==highlight==
  ].join('|'),
  'g',
);

/** 便宜的预判：没有任何记号就走原来的纯文本快路径（5000 节点 patch 的热路径，见 07）。 */
const MAYBE_RE = /[`*=[<]|https?:\/\/|www\./;

export function hasInlineMarkup(text: string): boolean {
  return MAYBE_RE.test(text) && matchesOf(text).length > 0;
}

interface Token {
  index: number;
  length: number;
  /** 显示文本在这段原文里的起始偏移（= 前缀记号长度），坐标换算用 */
  rawLead: number;
  build(): Node;
}

function matchesOf(text: string): Token[] {
  const out: Token[] = [];
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text)) !== null) {
    const [raw, , code, linkText, linkUrl, autoUrl, bold, mark] = m;
    if (raw.startsWith('[[') || raw.startsWith('![[')) continue; // wiki 链接：不归这里管
    const index = m.index;
    const push = (rawLead: number, build: () => Node): void => {
      out.push({ index, length: raw.length, rawLead, build });
    };
    if (code !== undefined) {
      push(raw.indexOf(code), () => el('code', 'md-code', code));
    } else if (linkText !== undefined && linkUrl !== undefined) {
      push(1, () => link(linkText, linkUrl));
    } else if (autoUrl !== undefined) {
      push(1, () => link(autoUrl, autoUrl));
    } else if (bold !== undefined) {
      push(2, () => el('strong', 'md-bold', bold));
    } else if (mark !== undefined) {
      push(2, () => el('mark', 'md-mark', mark));
    } else {
      push(0, () => link(raw, raw));
    }
  }
  return out;
}

function el(tag: string, className: string, text: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/**
 * 刻意用 span 而不是 <a href>：webview 里本来就不能靠 href 导航（打开走 host），
 * 留着 href 只会招来浏览器的默认行为——Alt+点击会被当成「下载链接」，
 * 于是「按修饰键进去改字」这条路直接失效（测试里逮到的）。
 */
function link(text: string, url: string): HTMLElement {
  const a = document.createElement('span');
  a.className = 'md-link';
  a.setAttribute('role', 'link');
  a.textContent = text;
  a.dataset.url = normalizeUrl(url);
  a.title = normalizeUrl(url);
  return a;
}

function normalizeUrl(url: string): string {
  return /^(?:https?|mailto):/i.test(url) ? url : `https://${url}`;
}

/**
 * 渲染成显示态。原文记在 `dataset.src` 上——`toSourceMode` 靠它还原，
 * nodeView 也靠它判断「这次 patch 要不要重建」（渲染后 textContent ≠ 源文本，不能拿它比对）。
 */
export function renderInline(elm: HTMLElement, text: string): void {
  const tokens = matchesOf(text);
  const parts: Node[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.index < cursor) continue; // 记号重叠时后者让位
    if (token.index > cursor) parts.push(document.createTextNode(text.slice(cursor, token.index)));
    parts.push(token.build());
    cursor = token.index + token.length;
  }
  if (cursor < text.length) parts.push(document.createTextNode(text.slice(cursor)));
  elm.replaceChildren(...parts);
  elm.dataset.src = text;
}

/** 还原成源码态（纯文本单 text node）。已是源码态时是空操作。 */
export function toSourceMode(elm: HTMLElement): void {
  const src = elm.dataset.src;
  if (src === undefined) return;
  delete elm.dataset.src;
  elm.textContent = src;
}

/** 该元素当前是显示态吗（渲染过、textContent 与源文本可能不同）。 */
export function isRendered(elm: HTMLElement): boolean {
  return elm.dataset.src !== undefined;
}


/**
 * 显示态偏移 → 源码偏移。显示态隐藏了记号，两套坐标不等长；点击落点必须先换算，
 * 否则光标会落错位置（越靠后的字符错得越多）。
 */
export function sourceOffset(text: string, renderedOffset: number): number {
  let rendered = 0;
  let cursor = 0;
  for (const token of matchesOf(text)) {
    if (token.index < cursor) continue;
    const plain = token.index - cursor; // 记号之间的普通文本，两套坐标一致
    if (renderedOffset <= rendered + plain) return cursor + (renderedOffset - rendered);
    rendered += plain;
    cursor = token.index;

    const shown = token.build().textContent?.length ?? 0;
    if (renderedOffset <= rendered + shown) {
      // 落在记号内部：按「显示文本里的第几个字」折算回源码（记号本身的长度补在前面）
      const lead = token.rawLead;
      return cursor + lead + (renderedOffset - rendered);
    }
    rendered += shown;
    cursor = token.index + token.length;
  }
  return Math.min(text.length, cursor + (renderedOffset - rendered));
}
