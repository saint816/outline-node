# AGENTS.md — 编码模型入口指引

本文件是所有参与本项目编码的 AI agent / 开发者的最高约束入口。开始任何编码前必须读完本文件，并按「阅读顺序」读完相关规格文档。

## 项目是什么

**OutlineNode**：一个基于本地 Markdown 的大纲笔记 VS Code 插件，最终发布到 VS Code Marketplace。

- 数据**完全基于本地文件**：标准 Markdown 缩进列表（`- ` 嵌套、`- [x]` 完成、缩进续行为节点备注），与 Obsidian/Logseq 互通，Git diff 可读。
- 架构：`CustomTextEditorProvider` + Webview。**TextDocument 是唯一事实源**，undo/redo、脏标记、保存、热恢复全部由 VS Code 提供，不自己造。
- UI：原生 TypeScript + 每节点一个 `contenteditable="plaintext-only"` div，**不使用任何运行时框架**（无 React/Vue/Svelte）。
- 功能目标：完整的大纲编辑体验——无限层级、Enter 拆分、Tab/Shift+Tab 缩进、Backspace 合并、折叠、Alt+↑↓ 移动、完成标记、节点备注、zoom-in + 面包屑、拖拽排序、实时搜索过滤、镜像引用。

## 阅读顺序

1. 本文件（红线与约定）
2. `docs/01-architecture.md` — 总体架构、目录结构、模块职责
3. `docs/02-data-model.md` — 数据模型（一切类型的源头）
4. 按当前所做里程碑（`docs/08-milestones.md`）选读对应专题文档：
   - parser/serializer → `docs/03-parser-serializer.md`
   - 同步协议 / DocumentSession → `docs/04-sync-protocol.md`
   - Webview 渲染 / 键盘 / 光标 / IME / 拖拽 / 搜索 / zoom → `docs/05-webview-ui.md`
   - 折叠状态 / 镜像引用 → `docs/06-folding-and-mirrors.md`
   - 性能 → `docs/07-performance.md`
5. 写测试前读 `docs/09-testing.md`；发布前读 `docs/10-publishing.md`

## 硬性红线（违反即返工，不接受任何理由）

1. **Round-trip 幂等**：对任意输入文本 `s`，`serialize(parse(s)) === s` 必须**字节级相等**；对任意编辑后文档，`parse(serialize(doc))` 必须与 `doc` 结构等价。所有 fixture 必须过此红线。
2. **最小 diff**：未被用户编辑的节点/块序列化时必须字节原样输出（走 `raw` 通道）。任何"顺手规范化"（改 bullet 符号、改缩进宽度、trim 空白）都是 bug。
3. **绝不把 UI 状态写进 markdown 文件**：折叠状态、zoom 位置、搜索词等一律不落盘到用户文件（折叠态走 `workspaceState`，见 `docs/06`）。
4. **IME 守卫**：`compositionstart`→`compositionend` 期间，正在编辑节点的 DOM 绝对不可被触碰（不 patch、不重建、不恢复光标），也不得发出 `setText`。中文输入丢字是最高优先级 bug。
5. **Undo 完全交给 VS Code**：webview 内浏览器原生 undo 栈必须被三道闸封死（见 `docs/05`），Ctrl/Cmd+Z 转发给 host 执行 `vscode.commands.executeCommand('undo')`。
6. **`src/core/` 零依赖**：core 目录不得 import `vscode` 模块、不得使用任何 DOM API（`document`/`window`/`HTMLElement`），必须能在纯 Node 环境下被 vitest 直接运行。
7. **编辑语义只实现一份**：所有编辑操作的语义只存在于 `src/core/ops.ts` 的 `applyOp`，extension host 与 webview 共用。禁止在 webview 里写"顺手改一下树"的旁路逻辑。
8. **不引入运行时框架/重依赖**：webview bundle 只允许 esbuild 打包的自有代码 + 极小工具库（如 nanoid）。出现 React/Vue/lodash 即返工。
9. **消息协议以 `src/shared/protocol.ts` 为唯一契约**：改协议必须同步改文档 `docs/04`，两端同时改，禁止私加字段绕过类型。

## 关键验收标准（分阶段验收细则见 `docs/08-milestones.md`）

- 与 VS Code 内置文本编辑器并排打开同一文件，任一侧编辑另一侧实时一致。
- 中文 IME 输入（含候选、联想、长句）零丢字、零重复。
- Ctrl/Cmd+Z 逐步回退，粒度接近原生编辑器（一小段连续打字或一次结构操作为一步），光标位置合理。
- Obsidian 打开同一 `.md` 文件内容语义等价（含镜像引用的块嵌入渲染）。
- 性能红线：5000 节点文件首帧 < 500ms；击键到屏幕反馈 < 16ms；外部 refresh patch < 50ms。

## 开发命令约定

| 命令 | 作用 |
|---|---|
| `npm run build` | esbuild 双入口构建（extension + webview）到 `dist/` |
| `npm run watch` | 构建 watch 模式（配合 F5 调试宿主） |
| `npm test` | vitest 跑 `test/unit/`（core 单测 + 协议 mock 测试） |
| `npm run test:webview` | playwright 跑 `test/webview/`（真实 DOM/键盘/IME） |
| `npm run test:integration` | @vscode/test-electron 跑 `test/integration/` |
| `npm run package` | `vsce package` 产出 .vsix |

环境：Node ≥ 20，TypeScript strict 模式，ESLint。调试：VS Code F5（`Run Extension` launch 配置）。

## 工程约定

- TypeScript `strict: true`；禁止 `any` 逃逸（协议边界用类型守卫收窄）。
- 模块保持单一职责，单文件目标 100–300 行；超过说明该拆了。
- 命名跟随 `docs/` 中给出的接口签名，不要自行重命名文档中已定义的类型/消息/Op。
- 提交信息用英文 conventional commits（`feat: ...` / `fix: ...` / `test: ...`）。
- 遇到文档没覆盖的设计决策：小事就地决定并在代码注释标注 `SPEC-GAP:`；影响协议/文件格式/红线的，停下来先补文档再写码。
