# OutlineNode

> 🚧 **WIP** — 开发中，尚未发布到 Marketplace。

Workflowy 风格的大纲笔记 VS Code 插件，数据完全基于本地 Markdown 文件。你的笔记就是标准的 `.md` 缩进列表——Obsidian / Logseq 直接能读，Git diff 干净可读，没有私有格式，没有云端锁定。

## 功能

- 无限层级大纲：Enter 拆分节点、Tab / Shift+Tab 缩进、Backspace 合并
- 折叠 / 展开（状态自动记忆，不污染文件）
- Zoom-in 聚焦任意节点 + 面包屑导航
- 完成标记（`- [x]`，灰色删除线）
- 节点备注（Shift+Enter，缩进续行存储）
- Alt+↑ / Alt+↓ 移动节点
- 拖拽排序（含改变层级）
- 实时搜索过滤
- 镜像引用：同一节点出现在多处并同步编辑（Obsidian 原生 `^id` / `![[#^id]]` 语法，Obsidian 中打开渲染语义等价）
- 完整中文 IME 支持；undo/redo 由 VS Code 原生提供

## 使用

- `*.outline.md` 文件默认用 OutlineNode 打开
- 普通 `*.md`：右上角 **Reopen Editor With… → Outline**，或命令面板 `OutlineNode: Open as Outline`
- 想让某个目录（如 Obsidian vault 的 `outlines/`）下所有 `.md` 默认用大纲打开，配置 VS Code 原生 `workbench.editorAssociations`

## 开发

参见 [AGENTS.md](AGENTS.md)（贡献者/编码 agent 入口）与 [docs/](docs/)（完整技术规格）。
