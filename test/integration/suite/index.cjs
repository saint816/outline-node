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
  const ext = vscode.extensions.all.find((e) => e.id.toLowerCase().endsWith('.outlinenode'));
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

test('折叠状态写入 workspaceState，不写进 markdown 文件', async () => {
  const uri = tempFile('folding.outline.md', '- parent\n  - child\n');
  const { document, session } = await openOutline(uri);

  await session.handleMessage({ type: 'saveFolding', foldedKeys: ['h:abc123'] });
  assert.equal(document.getText(), '- parent\n  - child\n');
  assert.equal(fs.readFileSync(uri.fsPath, 'utf8'), '- parent\n  - child\n');
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
