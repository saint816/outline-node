# 04 — 双向同步协议（shared/protocol.ts, core/ops.ts, extension/documentSession.ts）

## 总原则

webview 发**语义 op**（不是全文、不是 DOM diff），host 在自己的 mirror tree 上用**同一份** `applyOp` 重放 → serialize → 与当前文档做 `minimalEdits` → 最小 `WorkspaceEdit` 写回 TextDocument。语义 op 同时保证：最小 diff、合理的 undo 粒度、两端确定性一致。

```
webview                         host
dispatch(op)
  ├─ 本地 applyOp（乐观更新）
  ├─ renderer.patch
  └─ 发送队列 → edit{ops} ────► handleMessage
                                  ├─ baseVersion 校验（失配→refresh conflict）
                                  ├─ applyOp（同一份代码）
                                  ├─ serialize + minimalEdits
                                  ├─ expectedTexts 入队
                                  └─ workspace.applyEdit
                                onDidChangeTextDocument
                                  ├─ 命中 expectedTexts 队首 → ack ─► 仅推进 baseVersion，零 DOM
                                  └─ 未命中（外部修改）→ 防抖100ms → parse → treeMatch → refresh ─► 增量 patch + 恢复光标
```

## 消息协议（shared/protocol.ts，唯一契约）

```ts
// ---------- webview → host ----------
export type W2H =
  | { type: 'ready' }                                            // webview 加载完成/热恢复，请求 init
  | { type: 'edit'; baseVersion: number; seq: number; ops: Op[] }
  | { type: 'requestUndo' }
  | { type: 'requestRedo' }
  | { type: 'saveFolding'; foldedKeys: string[] }                // 折叠变化时节流上报（见 06）
  | { type: 'saveBookmarks'; bookmarkKeys: string[] }            // 星标变化时节流上报（nodeKey；UI-state，仿 saveFolding）
  | { type: 'saveImage'; name: string; dataBase64: string }     // 粘贴/拖入图片：name 是**相对文档目录的路径**（`<文件名>/assets/pasted-…`）
  | { type: 'copyText'; text: string };                         // 代码块复制按钮 → host `vscode.env.clipboard.writeText`（单向，无回执）

// ---------- host → webview ----------
export type H2W =
  // bookmarkKeys 可选：旧 host 不带时 webview 按空处理。locale 不走协议——host 注入 <html lang>。
  | { type: 'init';    snapshot: DocSnapshot; version: number; foldedKeys: string[]; bookmarkKeys?: string[]; config: EditorConfig }
  | { type: 'ack';     seq: number; version: number }            // 回声确认；webview 只推进 baseVersion
  | { type: 'refresh'; snapshot: DocSnapshot; version: number; cause: 'external' | 'undo' | 'conflict' }
  | { type: 'imageSaved'; name: string };                        // 图片写盘完成；webview 重渲染让 ![[name]] 加载得到文件

export interface EditorConfig {
  defaultIndent: IndentUnit;
  defaultFold: 'none' | 'firstLevel';
  rememberFolding: boolean;
}
```

`version` 一律使用 `TextDocument.version`（VS Code 原生递增），host 不自造版本号。

### 图片粘贴/拖入（saveImage / imageSaved）

单向 + 一次确认，**不改文件格式**（`.md` 只是普通文本插入 `![[name]]`，走正常 edit op；另写一个新二进制文件）：

1. webview 侧 `clipboard.ts` 读到剪贴板里的图片，生成 `<assetsDir>/pasted-<ts>-<rand>.<ext>`（`assetsDir` 来自 host 注入的 `data-assets-dir` = `<文件名去扩展名>/assets`），**经 store** 在光标处插入 `![[name]]`（`execCommand` 在 VS Code webview 里静默失败，见 05），并发 `saveImage{name, dataBase64}`。
2. host 侧在 **provider**（不是 DocumentSession——后者保持 vscode 无关）把 `name` 按 `/` 拆段逐段白名单校验（拒绝空段 / `.` / `..` / `\ : * ? " < > |`，最多 4 段），必要时 `createDirectory` 再 `workspace.fs.writeFile`。**协议字段形状未变**，只是 `name` 从纯文件名放宽为相对路径。
3. 写完回 `imageSaved{name}`，webview 收到后重渲染 + 给该图打 cache-bust（预览请求可能早于写盘，404 会被缓存，BUG-005）。无需 requestId 关联：重渲染是幂等的整体刷新。
4. **删除不与删节点耦合**：删节点只是文本编辑（可 undo），删文件不可 undo。孤儿图片走**保存后自动清理**（默认开，只动 `pasted-*`，移废纸篓）+ **显式命令** `outlineNode.cleanupImages`（全量 + 确认），见 `extension/imageCleanup.ts`。

图片能被 webview 加载依赖 `localResourceRoots` 含文档目录 + CSP `img-src`（见 05 / provider）。

### 复制到剪贴板（copyText）

单向、无回执、不碰文档：host 收到就 `vscode.env.clipboard.writeText(text)`。**刻意不在 webview 里用 `navigator.clipboard` / `execCommand`**——它们在 VS Code webview 下有静默失败的前科（见 05 图片粘贴一节与 docs/11），而「点了复制没反应」正是最难被发现的那类 bug。回执也不需要：UI 上的「已复制」是本地反馈，写剪贴板失败由 VS Code 自己报错。

## Op 全集（core/ops.ts）

```ts
export type Op =
  | { op: 'setText';  id: string; text: string }
  | { op: 'setNote';  id: string; note: string | null }
  | { op: 'split';    id: string; offset: number; newId: string }   // newId 由 webview 生成 nanoid，host 采纳
  | { op: 'mergeWithPrevious'; id: string }
  | { op: 'indent';   id: string }
  | { op: 'outdent';  id: string }
  | { op: 'moveUp';   id: string }
  | { op: 'moveDown'; id: string }
  | { op: 'move';     id: string; parentId: string | null; index: number }   // 拖拽 reparent
  | { op: 'toggleChecked'; id: string }
  | { op: 'setChecked'; id: string; checked: boolean | null }   // 直接设定完成态（斜杠菜单 To-do）
  | { op: 'insertSubtree'; parentId: string | null; index: number; nodes: NodeSnapshot[] }  // 粘贴/新建
  | { op: 'delete';   id: string }
  | { op: 'assignBlockId'; id: string; blockId: string }   // 镜像功能用（见 06），M6 前可不实现
  | { op: 'setRawBlock'; id: string; lines: string[] }     // 编辑围栏代码块（唯一能改 RawBlock.lines 的 op，见 02）
  | { op: 'toCodeBlock'; id: string; lang: string; blockId: string; restId: string }  // 空顶层根节点 → 顶层代码块
  | { op: 'deleteRawBlock'; id: string }                   // 删围栏代码块（BUG-004）
  | { op: 'insertRootAfterBlock'; afterBlockId: string; id: string; blockId: string };  // 某块后新建空根节点（BUG-003）

export interface OpResult { changed: boolean }   // false = no-op（如首节点 indent）
export function applyOp(doc: OutlineDoc, op: Op): OpResult;   // 原地修改 doc
```

### 每个 Op 的精确语义（两端必须一致，全部只实现在 applyOp）

- **setText**：替换 `text`；`raw = null`。目标不存在 → no-op（乐观更新竞态的兜底）。
- **setNote**：替换/清除 `note`；`raw = null`。
- **split**：`text[0, offset)` 留在原节点，`text[offset, ∞)` 归入新节点（id = `newId`）；新节点插入为原节点的**下一个兄弟**；`children`、`note`、`checked`、`blockId` 全部留在原节点，新节点为裸节点（`checked` 继承原节点的 `checked === null ? null : false`——任务列表里回车新建的是未完成任务，符合直觉）。两节点 `raw = null`。
  - `offset === 0` 时同样适用（原节点变空、全文归新节点），keymap 负责把光标放进新节点，等效"上方插入空行"。
  - 「展开且有子节点的节点在行尾回车 → 新建第一个子节点」是 UI 决策（依赖折叠状态，op 层不感知）：keymap 此时改发 `insertSubtree{parentId: id, index: 0, nodes: [空节点]}`，不用 split。
- **mergeWithPrevious**：目标 = 同一 ListBlock 内**先序遍历的前一个节点**（可能是父节点）。约束：本节点 `children` 非空 → no-op；本节点是 block 第一个节点 → no-op；本节点或目标是 mirror 行 → no-op。执行：`target.text += node.text`；note 合并（双方都有 → `'\n'` 连接，只有本节点有 → 移交）；删除本节点；双方 `raw = null`。caret 恢复位置（junction = 目标原 text 长度）由 webview 在 dispatch 前自行记录，不进 op。
- **indent**：节点成为**前一个兄弟**的最后一个子节点（连同整棵子树）。无前一个兄弟 → no-op。
- **outdent**：节点成为**其父节点的下一个兄弟**（连同子树）；原来位于它之后的同级兄弟保持在原父之下（Workflowy 语义）。已在 block 根层 → no-op。
- **moveUp / moveDown**：与前/后一个**兄弟**交换位置（子树整体移动）；边界 → no-op。跨层移动不在此 op 范围（用拖拽或 indent/outdent 组合）。
- **move**：从当前位置摘除，插入到 `parentId` 的 `children[index]`（`parentId === null` → 所在 ListBlock 的 roots[index]）。约束：`parentId` 不得是本节点或其后代（成环，applyOp 内校验，违反 → no-op）；v1 拖拽限制在同一 ListBlock 内。
- **toggleChecked**：`null → true`、`false → true`、`true → false`（决策理由见 02）。
- **setChecked**：直接把 `checked` 设为给定值（`null`/`false`/`true`）；同值 → no-op；`raw = null`。存在的理由：`toggleChecked` 表达不了 `null → false`（未勾选任务），斜杠菜单的 To-do 需要它。
- **insertSubtree**：把 `nodes`（含 webview 生成的 id）插入指定位置。id 冲突（已存在）→ no-op 整条拒绝。
- **delete**：删除节点及整棵子树。
- **assignBlockId**：设置节点的 `blockId`（创建镜像前置步骤，见 06）；文档内已存在同名 blockId → no-op；`raw = null`。
- **setRawBlock**：按 `id` 找到 RawBlock，整块替换 `lines`。**唯一能改 `RawBlock.lines` 的 op**（见 02 不变式 2 的例外）。守卫：目标不存在、不是 raw、或首行不是围栏（`` ``` `` / `~~~`）→ no-op（护住 frontmatter/标题等其余 RawBlock 的不可变性）；`lines` 与原相同 → no-op。webview 编辑代码块正文时保留首尾围栏行、只换中间正文。
- **toCodeBlock**：把**空的顶层根节点**转成顶层代码块。守卫：目标不存在、`parent !== null`（非根）、或有 `children`/`note`/`mirror` → no-op。执行：把该节点所在 ListBlock 从它的位置切开——`before` 段保留原 block id，插入代码块 RawBlock（id = `blockId`，`lines = ['```'+lang, '', '```']`），`after` 段用新 block id `restId`；空段不产出。`blockId`/`restId` 由 webview 生成、host 采纳，保证两端结构确定性一致（同 split 的 `newId`）。
- **deleteRawBlock**：删除**围栏代码块** RawBlock（BUG-004）。守卫：目标不存在、不是 raw、或首行不是围栏 → no-op（其余 RawBlock 不可删）。执行：移除该块；若删后**前后都是 ListBlock** 则合并成一个（否则模型里会留下两个相邻 ListBlock，与「重解析同一文本」得到的单个 ListBlock 不一致）。webview 手势：空代码块 textarea 上 Backspace/Delete。
- **insertRootAfterBlock**：在 `afterBlockId` 块后插入一个**空的顶层根节点**（id = `id`）（BUG-003：末尾代码块后继续录入的出口）。已有后继 ListBlock → 插到它开头；否则新建 ListBlock（id = `blockId`，webview 生成、host 采纳）。守卫：`id` 已存在、`afterBlockId` 不存在、或新建时 `blockId` 冲突 → no-op。webview 手势：代码块 textarea 上 Cmd/Ctrl+Enter。

结构性 op（除 setText/setNote 外全部）导致被移动/修改节点 `raw = null`；子树内其他节点 raw 保留，靠 `raw.depth` 失配机制自动重生成（见 02）。

## host 侧：DocumentSession

```ts
export class DocumentSession {
  constructor(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    folding: FoldingStore,
    config: EditorConfig,
  );
  handleMessage(msg: W2H): Promise<void>;
  onDocumentChanged(e: vscode.TextDocumentChangeEvent): void;   // provider 转发文档事件
  dispose(): void;   // 保存折叠态、清理防抖计时器
}
```

内部状态：`mirrorDoc: OutlineDoc`（带 raw 的权威树）、`expectedTexts: string[]`（回声队列）、`externalDebounce: Timer`。

### edit 处理流程

1. `msg.baseVersion !== document.version` → 丢弃 ops，回 `refresh{cause:'conflict', snapshot: 当前 mirrorDoc}`。
2. 逐个 `applyOp(mirrorDoc, op)`；全部 no-op → 直接回 `ack`（version 不变）。
3. `newText = serializeOutline(mirrorDoc)`；`edits = minimalEdits(document.getText(), newText)`。
4. `expectedTexts.push(newText)` → `workspace.applyEdit`。
5. applyEdit 返回 false（罕见：文档被关闭/竞态）→ 从队列移除该预期文本，重新 `parseOutline` 当前文档 + `treeMatch` 恢复 mirrorDoc，回 `refresh{cause:'conflict'}`。

### onDidChangeTextDocument（回声判定入口）

- `document.getText() === expectedTexts[0]` → 出队，回 `ack{seq, version: document.version}`。**用内容比对而非计数器**：天然扛住 applyEdit 合并、失败等边界。
- 否则 → 外部修改：防抖 100ms（连续外部写只处理最后一次）→ `newDoc = parseOutline(text)` → `matchTrees(mirrorDoc, newDoc)` 复用旧 id → `mirrorDoc = newDoc` → 回 `refresh{cause:'external'}`。
- 期间清空 `expectedTexts`（旧预期已失效）。

### undo / redo 转发

`requestUndo` → `vscode.commands.executeCommand('undo')`（作用于该 custom editor 的 TextDocument，CustomTextEditorProvider 免费提供 undo 栈）。文档随之变化走 onDidChangeTextDocument 的外部修改路径，`cause` 标为 `'undo'`（session 用一个 `pendingUndo` 标志区分）。webview 收到 `refresh{cause:'undo'}` 后 patch 并按 id 恢复光标。

## webview 侧：发送队列与防抖（store.ts）

- 维护 `baseVersion`（init/ack/refresh 推进）、`seq` 自增、待发 op 缓冲。
- **setText 防抖 300ms**，同一节点连续输入合并为最后一次；**连续输入超过 1s 强制 flush**（限制丢失窗口与 undo 步长）。
- **立即 flush 的时机**：任何结构性 op 入队之前、节点 blur、Ctrl/Cmd+Z（先 flush 再发 requestUndo）、`visibilitychange` 隐藏、`saveFolding` 之前。
- **批量 dispatch**（`dispatchAll(ops)`）：多选等场景把 n 个 op 依次乐观应用后合成**一条** `edit`。一条 `edit` = host 一次 `workspace.applyEdit` = **一个 VS Code undo 步**，所以批量操作能被一次 `Cmd+Z` 整体撤销。中途 no-op 的 op 不入队（协议不变，只是同一 `ops[]` 里多几条）。
- 收到 `refresh{cause:'conflict'}`：丢弃未 ack 的本地 op 队列，应用快照；若正在编辑的节点在新树中 id 存活，把 contenteditable 中未提交的文本作为新 `setText` 重新提交——用户感知几乎无损。**不做 OT/CRDT**：单用户单文件场景冲突窗口 < 防抖间隔，全量刷新 + 文本重提交是正确的复杂度。

## minimalEdits（core/lineDiff.ts）

```ts
export interface TextEditSpan { start: number; end: number; text: string }  // 字符偏移，host 转 Range
export function minimalEdits(oldText: string, newText: string): TextEditSpan[];
```

实现：按行裁剪公共前缀与公共后缀，中段作为单个替换 span（0 或 1 个 span）。不需要通用 diff 算法——单次 op 引起的变更总是局部连续的。恒等式测试：把 spans 应用到 oldText 恒等于 newText；`oldText === newText` 时返回 `[]`。

## treeMatch（core/treeMatch.ts）

```ts
export function matchTrees(oldDoc: OutlineDoc, newDoc: OutlineDoc): void;
// 原地把 newDoc 中节点的 id 替换为匹配到的 oldDoc 节点 id；未匹配的保留新 id
```

三级匹配（先高置信后启发）：
1. `blockId` 相等 → 精确匹配（rename/move 全免疫）；
2. `(text, note, checked)` 完全相等的未匹配节点，按文档先序一一配对；
3. 剩余未匹配节点按文档先序 zip 配对（位置启发）。

RawBlock 按 `lines.join('\n')` 相等 → 复用 id，否则按顺序 zip。

目的：Git checkout / 外部编辑后，折叠状态（挂在内存 id 上）与光标（按 id 恢复）尽量存活。匹配错误的代价只是折叠/光标漂移，不影响数据正确性。
