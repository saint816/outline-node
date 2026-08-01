# 09 — 测试策略

四层金字塔，仓位从重到轻：core 单测 > 协议 mock 测试 > webview DOM 测试 > VS Code 集成冒烟。

## 1. core 单测（vitest，`test/unit/`）— 最重仓位

**parser/serializer**（fixture 清单见 03）：
- 每个 fixture：`serializeOutline(parseOutline(s)) === s` **字节级严格相等**（红线 1）；
- `parseOutline(serializeOutline(parseOutline(s)))` 与首次解析结构等价（忽略 id/raw）；
- 结构断言：层级、text/checked/note/blockId/mirror 剥离正确、RawBlock 边界正确（frontmatter/fence/空行）。

**property test（fast-check）**：
- 随机生成合法树（受控字符集，排除已知歧义前缀如 `[x] `）→ serialize → parse → 结构等价；
- 随机文本 → parse → serialize → parse 幂等（第二轮起稳定）。

**ops**：每个 Op 的正常路径 + 边界 no-op（首节点 indent、根层 outdent、首节点 mergeWithPrevious、带子节点 merge、成环 move、id 冲突 insertSubtree）；结构 op 后 `raw` 失效正确、未动节点 raw 保留。

**lineDiff**：恒等式——`apply(minimalEdits(a, b), a) === b` 对随机 (a, b) 成立；`a === b` 时返回 `[]`；单点编辑产出 span 覆盖行数最小。

**treeMatch**：blockId 匹配 rename 存活；文本匹配 move 存活；重复文本按先序配对稳定。

**nodeKey**：blockId 优先；同文本多节点 occurrenceIndex 稳定。

## 2. 同步协议测试（vitest + mock，`test/unit/session.test.ts`）— 回归价值最高

`DocumentSession` 的 vscode 依赖收窄为可注入接口：

```ts
interface SessionHost {
  getText(): string;
  get version(): number;
  applyEdit(spans: TextEditSpan[]): Promise<boolean>;   // mock 内同步改文本、版本 +1、触发 change 回调
  postMessage(msg: H2W): void;                          // mock 内记录消息序列
  executeUndo(): void;
}
```

跑消息序列剧本，断言 postMessage 序列与最终文本：

- 连续 `edit`（setText 防抖合并后）→ 每条恰好一个 `ack`，无 `refresh`；
- 回声抑制：applyEdit 引发的 change 不产生 `refresh`；
- 外部修改（mock 直接改文本触发 change）→ 一条 `refresh{cause:'external'}`，且 treeMatch 后旧 id 存活；
- 竞态：in-flight edit 期间插入外部修改 → 后到的 edit 因 baseVersion 失配收到 `refresh{cause:'conflict'}`；
- applyEdit 返回 false → `refresh{cause:'conflict'}` 且 mirrorDoc 与文本重新对齐;
- undo：`requestUndo` → executeUndo → change → `refresh{cause:'undo'}`。
- Undo 排队：外部 refresh 后让 `applyEdit` 延迟完成，并发投递 `edit` + `requestUndo`；断言 Undo 不会越过 edit 撤销外部内容。

## 3. webview DOM 测试（playwright，`test/webview/`）

普通浏览器页面直接加载 `dist/webview.js` + mock `acquireVsCodeApi`（记录 postMessage、可注入 H2W 消息），驱动**真实键盘事件**——这是 contenteditable 细节唯一可靠的自动化手段：

- Enter 在行首/行中/行尾拆分，光标落点正确；展开有子节点行尾 Enter 建首子节点；
- Tab/Shift+Tab 缩进后光标偏移不变；
- Backspace 行首合并，光标落在 junction；
- 粘贴多行缩进列表还原层级；复制子树得到正确 markdown；
- **IME**：CDP `Input.imeSetComposition` / `Input.insertText` 模拟拼音输入序列（composition 中收到 refresh 不触碰 DOM，commit 后文本完整）；
- 拖拽：pointer 序列改变层级，产出的 `move` op 正确；
- 搜索过滤显隐与祖先链；zoom 渲染裁剪；折叠节点无 DOM。

## 4. 集成测试（@vscode/test-electron，`test/integration/`）— 冒烟层

- 打开 fixture → `vscode.openWith` 进入自定义编辑器 → 注入编辑消息 → 断言 `document.getText()` 精确匹配；
- dirty 标记出现/保存后消失；undo 命令后文本回退；
- 外部 `fs.writeFile` 后文档与 webview 同步（轮询断言）;
- CI（Linux）用 xvfb 跑。

## CI 编排（.github/workflows/ci.yml）

```
jobs: lint → unit (vitest) → webview (playwright) → integration (xvfb) → package (vsce, 产物上传)
```

性能基准（见 07）在 webview job 内跑，阈值取红线 ×2 容忍 CI 抖动；本地开发按红线严格执行。
