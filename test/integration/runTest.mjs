// @vscode/test-electron 冒烟层（见 docs/09 第 4 节）：下载 VS Code，加载本扩展，
// 跑 suite/index.cjs 里的断言。CI（Linux）用 xvfb-run 包一层。
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runTests } from '@vscode/test-electron';

const here = dirname(fileURLToPath(import.meta.url));

// 用例文件必须放在打开的工作区里：VS Code 只对工作区内的文件建文件监视器，
// 否则「外部写文件 → 文档重载」这一条根本收不到事件（不是产品问题，是环境问题）。
const workspace = mkdtempSync(join(tmpdir(), 'outlinenode-ws-'));

try {
  await runTests({
    extensionDevelopmentPath: resolve(here, '../..'),
    extensionTestsPath: resolve(here, 'suite/index.cjs'),
    launchArgs: [workspace, '--disable-extensions', '--disable-gpu', '--no-sandbox'],
    extensionTestsEnv: { OUTLINENODE_TEST_WORKSPACE: workspace },
  });
} catch (error) {
  console.error('integration tests failed:', error);
  process.exit(1);
}
