# 08 — 分阶段实施计划

每个里程碑结束都必须是**可运行、可演示**的状态。按顺序实施；M2 完成即达"可日常自用"最小价值线，从 M2 起 dogfooding（用本插件记自己的笔记暴露问题）。本计划不含时间预估——以验收标准为准，做完即过。

## M0 — 脚手架

**内容**：仓库初始化（git、LICENSE MIT、.gitignore）；package.json（contributes 按 `01-architecture.md` 片段）；tsconfig 三层；esbuild.mjs 双入口 + watch；ESLint；`outlineEditorProvider` 骨架——webview 里用只读 `<pre>` 显示文档全文；`.github/workflows/ci.yml` 骨架（install + lint + build）。

**验收**：
- F5 启动开发宿主，打开 `*.outline.md` 自动进入自定义编辑器显示内容；普通 `.md` 可通过 Reopen Editor With 进入。
- `npm run build` 产出 `dist/extension.js` + `dist/webview.js`；CI 绿。

## M1 — core 层

**内容**：`model.ts` / `parser.ts` / `serializer.ts` / `indent.ts` / `lineDiff.ts` 完整实现（规格见 02、03、04）；`test/unit/fixtures/` 全套（清单见 03）；vitest 配置与全部单测；fast-check property test。

**验收**：
- `npm test` 绿；**所有 fixture 字节级 round-trip 幂等**（红线 1）。
- core 无 vscode/DOM import（用 eslint 规则 `no-restricted-imports` 强制）。

## M2 — 编辑闭环 ★风险最高

**内容**：`ops.ts` 全部 Op；`shared/protocol.ts`；`documentSession.ts` 全流程（edit 校验重放 / 回声抑制 / 外部修改 treeMatch+refresh / conflict / undo 转发）；webview `store/renderer/nodeView/keymap/caret/ime` 首版——可编辑渲染 + setText/split/mergeWithPrevious/indent/outdent + 防抖与 flush 策略 + IME 守卫 + 光标保持 + undo 三道闸。

**验收**：
- 与 VS Code 内置文本编辑器并排打开同一文件，双向改动实时一致。
- 中文 IME 输入（含长句候选）零丢字零重复。
- Ctrl/Cmd+Z 逐步回退且光标合理；保存/脏标记/热恢复正常。
- 外部改文件（`echo >> file`、Git checkout）webview 正确刷新且光标不跳。
- 协议 mock 剧本测试绿（见 09）。

## M3 — 大纲功能

**内容**：折叠/展开 + `foldingStore` + `nodeKey` 持久化 + treeMatch 折叠存活；`moveUp/moveDown`（Alt+↑↓）；`toggleChecked` 完成态样式；note（Shift+Enter，`setNote`）；zoom + 面包屑 + setState 持久化。

**验收**：
- 手工 checklist 全过；重开文件折叠保留；move/indent 后折叠保留。
- 集成测试断言编辑后 `document.getText()` 精确等于期望 markdown。

## M4 — 搜索 + 拖拽

**内容**：搜索框实时过滤（祖先链保留、只切 class）；pointer 拖拽（指示线、水平偏移定深度、自动滚动、Esc 取消）；clipboard 粘贴拆子树 / 复制子树为 markdown。

**验收**：
- playwright webview 测试覆盖：拖拽改变层级后文档文本正确；粘贴 Workflowy 导出的缩进列表还原层级。

## M5 — 性能 + 打磨

**内容**：折叠惰性挂载、首帧 rAF 分片、5000 节点基准脚本入 CI；主题适配核查（明/暗/高对比）；键盘可达性（focus 环、aria）；空文件/新文件体验（占位提示、点击创建首节点）。

**验收**：`07-performance.md` 四项红线达标（CI 基准绿）。

## M6 — 镜像引用

**内容**：parser 的 `blockId`/`mirror` 支持（M1 已留字段，此处补齐解析）；`assignBlockId` op；mirror.ts 渲染层展开 + 复合 id 重写；环检测、断链降级；右键「Copy as mirror link」。

**验收**：
- 同文件镜像双向编辑实时同步；删除原节点镜像变断链不丢文；循环引用渲染占位符。
- **Obsidian 打开同一文件，镜像位置块嵌入渲染语义等价**。

## M7 — 发布

**内容**：按 `10-publishing.md` 清单执行——README（demo.gif、快捷键表、互通说明、editorAssociations 指导）、CHANGELOG、icon、publisher 注册、vsce package 实机验证、`release.yml`（tag → vsce + ovsx 双发布）。

**验收**：Marketplace 上线可安装；干净机器安装后 M2/M3 验收项抽查通过。
