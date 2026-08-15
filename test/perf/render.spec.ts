// 性能红线（docs/07）：5000 节点首帧 < 500ms、击键反馈 < 16ms、外部 refresh patch < 50ms。
// CI 阈值放宽 2 倍容忍机器抖动，本地按红线严格执行。
import { expect, test } from '@playwright/test';
import { HARNESS, CONFIG } from '../webview/support.js';
import { generateSnapshot } from './gen-fixture.js';

const factor = process.env.CI ? 2 : 1;
const FIRST_FRAME_MS = 500 * factor;
const KEYSTROKE_MS = 16 * factor;
const PATCH_MS = 50 * factor;

const snapshot = generateSnapshot({ count: 5000 });

test.describe('5000 节点性能基准', () => {
  test(`首帧可交互 < ${FIRST_FRAME_MS}ms，且分片把 5000 个节点全部挂完`, async ({ page }) => {
    await page.goto(HARNESS);
    await page.waitForFunction(() => (window as never as { __posted: unknown[] }).__posted.length > 0);

    const firstFrame = await page.evaluate(
      async ({ snapshot, config }) => {
        const start = performance.now();
        (window as never as { __inject(msg: unknown): void }).__inject({
          type: 'init',
          snapshot,
          version: 1,
          foldedKeys: [],
          config,
        });
        await new Promise<void>((resolve) => {
          const check = (): void => {
            if (document.querySelectorAll('.node').length > 0) resolve();
            else requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        });
        return performance.now() - start;
      },
      { snapshot, config: CONFIG },
    );

    console.log(`first frame: ${firstFrame.toFixed(1)}ms (limit ${FIRST_FRAME_MS}ms)`);
    expect(firstFrame).toBeLessThan(FIRST_FRAME_MS);

    // 首帧只挂一小片，剩下的按帧追加，最终全部到位
    await expect.poll(() => page.locator('.node').count(), { timeout: 15000 }).toBe(5000);
  });

  test(`击键到屏幕的 JS 开销 < ${KEYSTROKE_MS}ms/次`, async ({ page }) => {
    await mount(page);

    const perKeystroke = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.node[data-id="n0"] [data-field="text"]')!;
      el.focus();
      const rounds = 50;
      const start = performance.now();
      for (let i = 0; i < rounds; i++) {
        el.textContent = 'x'.repeat(i + 1);
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
      return (performance.now() - start) / rounds;
    });

    console.log(`keystroke: ${perKeystroke.toFixed(2)}ms (limit ${KEYSTROKE_MS}ms)`);
    // 打字热路径上没有任何重渲染：这是击键 < 16ms 的根基（docs/07）
    expect(perKeystroke).toBeLessThan(KEYSTROKE_MS);
  });

  test(`外部 refresh 的增量 patch < ${PATCH_MS}ms`, async ({ page }) => {
    await mount(page);

    const patched = await page.evaluate(
      async ({ snapshot }) => {
        const next = structuredClone(snapshot) as {
          blocks: { roots: { id: string; text: string; children: unknown[] }[] }[];
        };
        // 改动分散在树里的三个节点，模拟一次外部编辑
        const targets = [0, 5, 9];
        let lastTarget: { id: string; text: string } | null = null;
        for (const i of targets) {
          const node = next.blocks[0].roots[i];
          if (node) {
            node.text = '外部改动 ' + i;
            lastTarget = { id: node.id, text: node.text };
          }
        }

        const start = performance.now();
        (window as never as { __inject(msg: unknown): void }).__inject({
          type: 'refresh',
          snapshot: next,
          version: 2,
          cause: 'external',
        });
        await new Promise<void>((resolve) => {
          const check = (): void => {
            // 只读取已知变更节点：textContent 验证 patch 已落 DOM，但不会像 body.innerText
            // 那样遍历 5000 节点并强制全页布局，把无关排版成本算进 patch 基准。
            const changed = lastTarget
              ? document.querySelector<HTMLElement>(
                  `.node[data-id="${CSS.escape(lastTarget.id)}"] [data-field="text"]`,
                )
              : null;
            if (changed?.textContent === lastTarget?.text) resolve();
            else requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        });
        return performance.now() - start;
      },
      { snapshot },
    );

    console.log(`external refresh patch: ${patched.toFixed(1)}ms (limit ${PATCH_MS}ms)`);
    expect(patched).toBeLessThan(PATCH_MS);
  });
});

async function mount(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(HARNESS);
  await page.waitForFunction(() => (window as never as { __posted: unknown[] }).__posted.length > 0);
  await page.evaluate(
    ({ snapshot, config }) => {
      (window as never as { __inject(msg: unknown): void }).__inject({
        type: 'init',
        snapshot,
        version: 1,
        foldedKeys: [],
        config,
      });
    },
    { snapshot, config: CONFIG },
  );
  await expect.poll(() => page.locator('.node').count(), { timeout: 15000 }).toBe(5000);
}
