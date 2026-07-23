import { resolve } from 'node:path';
import type { Page } from '@playwright/test';

// playwright 把测试转译成 CJS，用不了 import.meta；它总是从仓库根目录运行。
export const HARNESS = 'file://' + resolve(process.cwd(), 'test/webview/harness.html');

export interface TestNode {
  id: string;
  text: string;
  checked?: boolean | null;
  note?: string | null;
  children?: TestNode[];
}

export function node(id: string, text: string, children: TestNode[] = []): TestNode {
  return { id, text, children };
}

function toSnapshotNode(n: TestNode): unknown {
  return {
    id: n.id,
    text: n.text,
    checked: n.checked ?? null,
    note: n.note ?? null,
    blockId: null,
    mirror: null,
    children: (n.children ?? []).map(toSnapshotNode),
    raw: null,
  };
}

export function snapshot(nodes: TestNode[], blockId = 'block-1'): unknown {
  return {
    indentUnit: { kind: 'space', width: 2 },
    blocks: [{ kind: 'list', id: blockId, roots: nodes.map(toSnapshotNode) }],
  };
}

export const CONFIG = {
  defaultIndent: { kind: 'space', width: 2 },
  defaultFold: 'none',
  rememberFolding: true,
};

/** 打开 harness 并下发 init。 */
export async function openOutline(page: Page, nodes: TestNode[], version = 1): Promise<void> {
  await page.goto(HARNESS);
  await page.waitForFunction(() => (window as never as HarnessWindow).__posted.length > 0);
  await inject(page, {
    type: 'init',
    snapshot: snapshot(nodes),
    version,
    foldedKeys: [],
    config: CONFIG,
  });
  await page.waitForSelector('.node');
}

interface HarnessWindow {
  __posted: Record<string, unknown>[];
  __inject(msg: unknown): void;
}

export async function inject(page: Page, msg: unknown): Promise<void> {
  await page.evaluate((m) => (window as never as HarnessWindow).__inject(m), msg);
}

export async function posted(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() => (window as never as HarnessWindow).__posted);
}

export async function clearPosted(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as never as HarnessWindow).__posted.length = 0;
  });
}

/** 等待并返回下一条 edit 消息（setText 有 300ms 防抖）。 */
export async function waitForEdit(page: Page): Promise<Record<string, unknown>> {
  await page.waitForFunction(
    () => (window as never as HarnessWindow).__posted.some((m) => m.type === 'edit'),
    undefined,
    { timeout: 3000 },
  );
  const all = await posted(page);
  return all.filter((m) => m.type === 'edit').at(-1)!;
}

/** 把光标放到某个节点正文的指定偏移。 */
export async function focusText(page: Page, id: string, offset: number): Promise<void> {
  await page.evaluate(
    ({ id, offset }) => {
      const el = document.querySelector<HTMLElement>(`.node[data-id="${id}"] [data-field="text"]`)!;
      el.focus();
      const range = document.createRange();
      const textNode = el.firstChild;
      if (textNode) range.setStart(textNode, Math.min(offset, textNode.textContent?.length ?? 0));
      else range.setStart(el, 0);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    },
    { id, offset },
  );
}

/** 当前光标位置（节点 id + 偏移）。 */
export async function caretState(page: Page): Promise<{ id: string | null; offset: number }> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    if (!selection || selection.focusNode === null) return { id: null, offset: -1 };
    const start =
      selection.focusNode.nodeType === Node.TEXT_NODE
        ? selection.focusNode.parentElement
        : (selection.focusNode as HTMLElement);
    const nodeEl = start?.closest<HTMLElement>('.node');
    return { id: nodeEl?.dataset.id ?? null, offset: selection.focusOffset };
  });
}

export async function textsInDom(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-field="text"]')].map((el) => el.textContent ?? ''),
  );
}
