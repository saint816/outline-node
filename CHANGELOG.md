# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## [Unreleased]

### Added

- M0 脚手架：package.json（customEditors 双 viewType）、三层 tsconfig、esbuild 双入口构建、ESLint、CI 骨架、只读 `<pre>` 版自定义编辑器。
- M1 core 层：`model.ts` / `indent.ts` / `parser.ts` / `serializer.ts` / `lineDiff.ts`，全套 fixture 字节级 round-trip 幂等测试与 fast-check property test。
- M2 编辑闭环：`ops.ts`（全部 Op）/ `treeMatch.ts` / `shared/protocol.ts` / `documentSession.ts` / `foldingStore.ts`；webview 首版（store / renderer / nodeView / caret / ime / keymap）——可编辑渲染、setText 防抖、split/merge/indent/outdent、IME 守卫、光标保持、undo 三道闸；协议剧本测试与 playwright webview/IME 测试。
- M3 大纲功能：折叠（子树不挂载 DOM）+ `core/nodeKey.ts` 持久化 + treeMatch 折叠存活、Alt+↑↓ 移动、Cmd/Ctrl+Enter 完成态、Shift+Enter 节点备注、zoom + 面包屑 + `setState` 热恢复、↑↓ 跨节点移动光标；@vscode/test-electron 集成测试。
- M4 搜索 + 拖拽：实时过滤（祖先链保留、只切 class、搜索时穿透折叠）、pointer 拖拽排序（指示线、水平偏移定深度、边缘自动滚动、Esc 取消）、剪贴板（粘贴缩进列表还原层级、复制/剪切子树为 markdown）。
- M5 性能与打磨：首帧 rAF 分片挂载、5000 节点基准入 CI（parse/首帧/击键/patch 四项红线）、ARIA tree 语义与 focus 环、高对比度与减少动效媒体查询、样式零硬编码颜色核查。
