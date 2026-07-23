# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## [Unreleased]

### Added

- M0 脚手架：package.json（customEditors 双 viewType）、三层 tsconfig、esbuild 双入口构建、ESLint、CI 骨架、只读 `<pre>` 版自定义编辑器。
- M1 core 层：`model.ts` / `indent.ts` / `parser.ts` / `serializer.ts` / `lineDiff.ts`，全套 fixture 字节级 round-trip 幂等测试与 fast-check property test。
