// 性能红线之一（docs/07）：5000 节点 parseOutline < 20ms。
// CI 机器抖动大，阈值放宽 2 倍；本地按红线严格执行。
import { describe, expect, it } from 'vitest';
import { parseOutline } from '../../src/core/parser.js';
import { serializeOutline } from '../../src/core/serializer.js';
import { generateOutline } from './gen-fixture.js';

const LIMIT_MS = process.env.CI ? 40 : 20;
const PARSE_OPTS = { defaultIndent: { kind: 'space' as const, width: 2 } };

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

describe('性能红线：core', () => {
  const text = generateOutline({ count: 5000 });

  it('fixture 规模符合预期', () => {
    const doc = parseOutline(text, PARSE_OPTS);
    const count = countNodes(doc.blocks);
    expect(count).toBe(5000);
    expect(text.length).toBeGreaterThan(60_000);
  });

  it(`5000 节点 parseOutline 中位数 < ${LIMIT_MS}ms`, () => {
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      parseOutline(text, PARSE_OPTS);
      samples.push(performance.now() - start);
    }
    const value = median(samples);
    console.log(`parseOutline(5000): ${value.toFixed(1)}ms (limit ${LIMIT_MS}ms)`);
    expect(value).toBeLessThan(LIMIT_MS);
  });

  it(`5000 节点 serializeOutline 中位数 < ${LIMIT_MS}ms`, () => {
    const doc = parseOutline(text, PARSE_OPTS);
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      serializeOutline(doc);
      samples.push(performance.now() - start);
    }
    const value = median(samples);
    console.log(`serializeOutline(5000): ${value.toFixed(1)}ms (limit ${LIMIT_MS}ms)`);
    expect(value).toBeLessThan(LIMIT_MS);
  });

  it('5000 节点 round-trip 仍然字节级相等', () => {
    expect(serializeOutline(parseOutline(text, PARSE_OPTS))).toBe(text);
  });
});

function countNodes(blocks: readonly { kind: string }[]): number {
  let count = 0;
  const walk = (nodes: { children: unknown[] }[]): void => {
    for (const node of nodes) {
      count++;
      walk(node.children as { children: unknown[] }[]);
    }
  };
  for (const block of blocks) {
    if (block.kind === 'list') walk((block as unknown as { roots: { children: unknown[] }[] }).roots);
  }
  return count;
}
