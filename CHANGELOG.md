# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## [Unreleased]

### Added

- M0 脚手架：package.json（customEditors 双 viewType）、三层 tsconfig、esbuild 双入口构建、ESLint、CI 骨架、只读 `<pre>` 版自定义编辑器。
- M1 core 层：`model.ts` / `indent.ts` / `parser.ts` / `serializer.ts` / `lineDiff.ts`，全套 fixture 字节级 round-trip 幂等测试与 fast-check property test。
- M2 编辑闭环：`ops.ts`（全部 Op）/ `treeMatch.ts` / `shared/protocol.ts` / `documentSession.ts` / `foldingStore.ts`；webview 首版（store / renderer / nodeView / caret / ime / keymap）——可编辑渲染、setText 防抖、split/merge/indent/outdent、IME 守卫、光标保持、undo 三道闸；协议剧本测试与 playwright webview/IME 测试。
