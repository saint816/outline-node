// 集成测试用例。VS Code 用 require 加载本文件并调用 run()；
// 刻意不引 mocha：断言失败直接抛，runTest 以非零码退出。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

async function waitFor(predicate, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timeout: ' + message);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function tempFile(name, content) {
  // 必须落在被打开的工作区里，外部写文件才会触发 VS Code 的文件监视器
  const root = process.env.OUTLINENODE_TEST_WORKSPACE ?? os.tmpdir();
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return vscode.Uri.file(file);
}

function api() {
  const ext = vscode.extensions.all.find((e) => e.id.toLowerCase().endsWith('.outline-node'));
  assert.ok(ext, 'extension not found');
  return ext.exports;
}

/** 打开自定义编辑器并拿到该文档的 session。 */
async function openOutline(uri) {
  await vscode.commands.executeCommand('vscode.openWith', uri, 'outlineNode.outline');
  const document = await vscode.workspace.openTextDocument(uri);
  const session = await waitFor(() => api().getSession(uri.toString()), 'session for ' + uri.fsPath);
  return { document, session };
}

function flatten(snapshot) {
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      out.push(n);
      walk(n.children);
    }
  };
  for (const block of snapshot.blocks) if (block.kind === 'list') walk(block.roots);
  return out;
}

const nodeByText = (session, text) => {
  const hit = flatten(session.snapshot()).find((n) => n.text === text);
  assert.ok(hit, `no node with text ${JSON.stringify(text)}`);
  return hit;
};

// ---------- 用例 ----------

test('*.outline.md 进入自定义编辑器，扩展被激活', async () => {
  const uri = tempFile('smoke.outline.md', '- alpha\n');
  const { document } = await openOutline(uri);
  assert.equal(document.getText(), '- alpha\n');
  assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.input?.viewType, 'outlineNode.outline');
});

test('编辑后 document.getText() 精确等于期望 markdown，脏标记出现、保存后消失', async () => {
  const uri = tempFile('edit.outline.md', '---\ntitle: t\n---\n\n- alpha\n  - beta\n\n结尾。\n');
  const { document, session } = await openOutline(uri);

  await session.handleMessage({
    type: 'edit',
    baseVersion: document.version,
    seq: 1,
    ops: [{ op: 'setText', id: nodeByText(session, 'beta').id, text: 'BETA' }],
  });
  await waitFor(() => document.getText().includes('BETA'), 'edit applied');

  assert.equal(document.getText(), '---\ntitle: t\n---\n\n- alpha\n  - BETA\n\n结尾。\n');
  assert.equal(document.isDirty, true);

  await vscode.commands.executeCommand('workbench.action.files.save');
  await waitFor(() => !document.isDirty, 'saved');
  assert.equal(fs.readFileSync(uri.fsPath, 'utf8'), document.getText());
});

test('结构 op 写回：indent / split 的 markdown 精确匹配', async () => {
  const uri = tempFile('struct.outline.md', '- a\n- b\n');
  const { document, session } = await openOutline(uri);

  await session.handleMessage({
    type: 'edit',
    baseVersion: document.version,
    seq: 1,
    ops: [{ op: 'indent', id: nodeByText(session, 'b').id }],
  });
  await waitFor(() => document.getText() === '- a\n  - b\n', 'indent applied');

  await session.handleMessage({
    type: 'edit',
    baseVersion: document.version,
    seq: 2,
    ops: [{ op: 'split', id: nodeByText(session, 'a').id, offset: 1, newId: 'int-1' }],
  });
  await waitFor(() => document.getText() === '- a\n  - b\n- \n', 'split applied');
});

test('undo 命令回退到编辑前的文本', async () => {
  const uri = tempFile('undo.outline.md', '- one\n');
  const { document, session } = await openOutline(uri);

  await session.handleMessage({
    type: 'edit',
    baseVersion: document.version,
    seq: 1,
    ops: [{ op: 'setText', id: nodeByText(session, 'one').id, text: 'ONE' }],
  });
  await waitFor(() => document.getText() === '- ONE\n', 'edit applied');

  await vscode.commands.executeCommand('undo');
  await waitFor(() => document.getText() === '- one\n', 'undo applied');
});

test('BUG-001：两个独立结构 op（中间保存），单次 undo 只回退最后一个', async () => {
  const uri = tempFile('undo-gran.outline.md', '- a\n- b\n');
  const { document, session } = await openOutline(uri);

  // op1：把 a 标为完成
  await session.handleMessage({
    type: 'edit',
    baseVersion: document.version,
    seq: 1,
    ops: [{ op: 'toggleChecked', id: nodeByText(session, 'a').id }],
  });
  await waitFor(() => document.getText() === '- [x] a\n- b\n', 'op1 applied');
  await vscode.commands.executeCommand('workbench.action.files.save');
  await waitFor(() => !document.isDirty, 'saved1');

  // op2：把 b 上移，与 a 交换
  await session.handleMessage({
    type: 'edit',
    baseVersion: document.version,
    seq: 2,
    ops: [{ op: 'moveUp', id: nodeByText(session, 'b').id }],
  });
  await waitFor(() => document.getText() === '- b\n- [x] a\n', 'op2 applied');
  await vscode.commands.executeCommand('workbench.action.files.save');
  await waitFor(() => !document.isDirty, 'saved2');

  // 单次 undo 只应回退 op2（移动），a 仍保持完成态
  await vscode.commands.executeCommand('undo');
  await waitFor(() => document.getText() === '- [x] a\n- b\n', 'undo 只回退最后一个 op');
});

test('BUG-001-rapid：两个快速连续 op（不保存），单次 undo 只回退最后一个', async () => {
  const uri = tempFile('undo-rapid.outline.md', '- a\n- b\n- c\n');
  const { document, session } = await openOutline(uri);

  await session.handleMessage({
    type: 'edit',
    baseVersion: document.version,
    seq: 1,
    ops: [{ op: 'indent', id: nodeByText(session, 'b').id }],
  });
  await waitFor(() => document.getText() === '- a\n  - b\n- c\n', 'op1 applied');

  // 紧接着第二个 op，不保存、不等（模拟 Tab/Shift+Tab 快速连打）
  await session.handleMessage({
    type: 'edit',
    baseVersion: document.version,
    seq: 2,
    ops: [{ op: 'indent', id: nodeByText(session, 'c').id }],
  });
  await waitFor(() => document.getText() === '- a\n  - b\n  - c\n', 'op2 applied');

  // 单次 undo 只应回退 op2（c 的缩进），b 的缩进保留
  await vscode.commands.executeCommand('undo');
  await waitFor(() => document.getText() === '- a\n  - b\n- c\n', 'rapid undo 只回退最后一个 op');
});

// undo 粒度契约：一条 edit 消息 = 一次 applyEdit = 一个 undo step。webview 在 ack 往返前把
// 多个 op 批进同一条消息时它们一起 undo（单-in-flight 协议的固有结果，非 BUG-001）。
// BUG-001 报告的「间隔操作被合并」在上面两条用例里已证明不复现——独立消息各自成 undo step。
test('undo 粒度：一条 edit 消息（批处理多 op）单次 undo 一起退', async () => {
  const uri = tempFile('undo-batched.outline.md', '- a\n- b\n- c\n');
  const { document, session } = await openOutline(uri);

  // 模拟 webview 在 ack 之前把两个 op 批进同一条消息
  await session.handleMessage({
    type: 'edit',
    baseVersion: document.version,
    seq: 1,
    ops: [
      { op: 'indent', id: nodeByText(session, 'b').id },
      { op: 'indent', id: nodeByText(session, 'c').id },
    ],
  });
  await waitFor(() => document.getText() === '- a\n  - b\n  - c\n', 'batched applied');

  // 一条消息 = 一次 applyEdit = 一个 undo step：单次 undo 回退整条消息（符合预期，非 bug）
  await vscode.commands.executeCommand('undo');
  await waitFor(() => document.getText() === '- a\n- b\n- c\n', 'batched undo 全退');
});

test('外部 fs.writeFile 后文档与 session 同步', async () => {
  const uri = tempFile('external.outline.md', '- keep\n');
  const { document, session } = await openOutline(uri);

  fs.writeFileSync(uri.fsPath, '- keep\n- 外部追加\n', 'utf8');
  await waitFor(
    () => document.getText().includes('外部追加'),
    'document reloaded after external write',
  );
  await waitFor(
    () => flatten(session.snapshot()).some((n) => n.text === '外部追加'),
    'session mirrorDoc resynced',
  );
});

test('外部刷新后立即编辑并 Undo：只撤销 Webview 编辑，保留外部内容', async () => {
  const uri = tempFile('external-undo.outline.md', '- [ ] task\n');
  const { document, session } = await openOutline(uri);

  fs.writeFileSync(uri.fsPath, '- [ ] task\n- external keep\n', 'utf8');
  await waitFor(
    () => document.getText() === '- [ ] task\n- external keep\n',
    'document reloaded before edit',
  );
  await waitFor(
    () => flatten(session.snapshot()).some((n) => n.text === 'external keep'),
    'session refreshed before edit',
  );

  // 刻意不等待 edit 完成，复现 provider 连续收到 edit + requestUndo 的真实时序。
  const edit = session.handleMessage({
    type: 'edit',
    baseVersion: document.version,
    seq: 1,
    ops: [{ op: 'toggleChecked', id: nodeByText(session, 'task').id }],
  });
  const undo = session.handleMessage({ type: 'requestUndo' });
  await Promise.all([edit, undo]);

  await waitFor(
    () => document.getText() === '- [ ] task\n- external keep\n',
    'undo webview edit without removing external content',
  );
});

test('折叠状态写入 workspaceState，不写进 markdown 文件', async () => {
  const uri = tempFile('folding.outline.md', '- parent\n  - child\n');
  const { document, session } = await openOutline(uri);

  await session.handleMessage({ type: 'saveFolding', foldedKeys: ['h:abc123'] });
  assert.equal(document.getText(), '- parent\n  - child\n');
  assert.equal(fs.readFileSync(uri.fsPath, 'utf8'), '- parent\n  - child\n');
});

test('镜像：编辑原节点只改原行，引用行字节不动；assignBlockId 写入行尾 ^id', async () => {
  const uri = tempFile('mirror.outline.md', '- 写周报 ^k3f9a2\n  - 收集数据\n- 本周\n  - ![[#^k3f9a2]]\n');
  const { document, session } = await openOutline(uri);

  await session.handleMessage({
    type: 'edit',
    baseVersion: document.version,
    seq: 1,
    ops: [{ op: 'setText', id: nodeByText(session, '写周报').id, text: '写月报' }],
  });
  await waitFor(() => document.getText().includes('写月报'), 'source edited');
  // 引用行原样保留：Obsidian 里仍然是同一个块嵌入
  assert.equal(document.getText(), '- 写月报 ^k3f9a2\n  - 收集数据\n- 本周\n  - ![[#^k3f9a2]]\n');

  await session.handleMessage({
    type: 'edit',
    baseVersion: document.version,
    seq: 2,
    ops: [{ op: 'assignBlockId', id: nodeByText(session, '本周').id, blockId: 'abc123' }],
  });
  await waitFor(() => document.getText().includes('^abc123'), 'blockId assigned');
  assert.equal(
    document.getText(),
    '- 写月报 ^k3f9a2\n  - 收集数据\n- 本周 ^abc123\n  - ![[#^k3f9a2]]\n',
  );
});

// ---------- 运行 ----------

exports.run = async function run() {
  const failures = [];
  for (const { name, fn } of cases) {
    try {
      await fn();
      console.log('  ✓ ' + name);
    } catch (error) {
      failures.push({ name, error });
      console.error('  ✗ ' + name + '\n    ' + (error && error.stack ? error.stack : error));
    }
  }
  console.log(`\n${cases.length - failures.length}/${cases.length} integration tests passed`);
  if (failures.length > 0) throw new Error(`${failures.length} integration test(s) failed`);
};
