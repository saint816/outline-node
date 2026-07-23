// 确定性基准 fixture 生成器（见 docs/07）：深度 1–6 混合、10% 带 note、10% 带 checkbox。
// 同一份数据同时喂给 parse 基准（vitest）与渲染基准（playwright）。

/** mulberry32：小而确定的 PRNG，保证每次生成的文件字节一致。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['规划', '周报', 'review', '写文档', 'bug', '想法', '会议', 'refactor', '读书', '实验'];

export interface FixtureOptions {
  count?: number;
  seed?: number;
  maxDepth?: number;
}

/** 生成 count 个节点的 markdown 大纲（2 空格缩进）。 */
export function generateOutline(options: FixtureOptions = {}): string {
  const count = options.count ?? 5000;
  const maxDepth = options.maxDepth ?? 6;
  const random = rng(options.seed ?? 42);

  const lines: string[] = [];
  let depth = 0;

  for (let i = 0; i < count; i++) {
    const roll = random();
    // 深度随机游走，夹在 [0, maxDepth-1]
    if (roll < 0.28) depth = Math.min(depth + 1, maxDepth - 1);
    else if (roll < 0.5) depth = Math.max(depth - 1, 0);

    const indent = '  '.repeat(depth);
    const word = WORDS[Math.floor(random() * WORDS.length)];
    const checkboxRoll = random();
    const checkbox = checkboxRoll < 0.05 ? '[x] ' : checkboxRoll < 0.1 ? '[ ] ' : '';
    lines.push(`${indent}- ${checkbox}${word} ${i}`);
    if (random() < 0.1) lines.push(`${indent}  备注 ${i}：${word}`);
  }

  return lines.join('\n') + '\n';
}

/** 生成与 DocSnapshot 同构的树（供 webview 基准直接注入，跳过 host）。 */
export function generateSnapshot(options: FixtureOptions = {}): {
  indentUnit: { kind: 'space'; width: number };
  blocks: unknown[];
} {
  const text = generateOutline(options);
  const lines = text.split('\n').filter((line) => line !== '');

  interface Node {
    id: string;
    text: string;
    checked: boolean | null;
    note: string | null;
    blockId: null;
    mirror: null;
    children: Node[];
    raw: null;
  }

  const roots: Node[] = [];
  const stack: { width: number; node: Node }[] = [];
  let counter = 0;

  for (const line of lines) {
    const match = /^( *)- (\[[ x]\] )?(.*)$/.exec(line);
    if (!match) {
      // note 续行
      const owner = stack[stack.length - 1]?.node;
      if (owner) owner.note = (owner.note === null ? '' : owner.note + '\n') + line.trim();
      continue;
    }
    const width = match[1].length;
    const node: Node = {
      id: 'n' + counter++,
      text: match[3],
      checked: match[2] === undefined ? null : match[2] === '[x] ',
      note: null,
      blockId: null,
      mirror: null,
      children: [],
      raw: null,
    };
    while (stack.length > 0 && stack[stack.length - 1].width >= width) stack.pop();
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1].node.children.push(node);
    stack.push({ width, node });
  }

  return {
    indentUnit: { kind: 'space', width: 2 },
    blocks: [{ kind: 'list', id: 'perf-block', roots }],
  };
}
