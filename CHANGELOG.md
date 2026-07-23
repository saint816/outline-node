# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## [0.1.1] - 2026-07-24

### Changed

- README 默认语言改为英文（Marketplace 门面与 GitHub 首页），中文版保留在 `README.zh-CN.md`，两边互相链接。

## [0.1.0] - 2026-07-23

首个公开版本。

### Added

- **大纲编辑器**：`*.outline.md` 默认打开；普通 `*.md` 可通过 Reopen With 或 `OutlineNode: Open as Outline` 打开。
- **结构编辑**：`Enter` 拆分、`Tab` / `Shift+Tab` 调整层级、`Backspace` 合并、`Alt+↑/↓` 移动整棵子树、鼠标拖拽跨层级排序。
- **折叠 / 展开**（`Cmd/Ctrl+.`）：折叠状态存在 VS Code 里，不写入文件；文件被外部修改后仍能对上原来的节点。
- **Zoom-in**（`Alt+←/→`）：聚焦任意子树并显示面包屑，窗口重开后自动恢复。
- **完成标记**（`Cmd/Ctrl+Enter`）：序列化为标准的 `- [x]`。
- **节点备注**（`Shift+Enter`）：按缩进续行存储，支持多行。
- **实时搜索过滤**（`Cmd/Ctrl+F`）：保留祖先链，搜索时穿透折叠。
- **剪贴板**：粘贴缩进列表自动还原层级，复制 / 剪切输出标准 Markdown 子树。
- **镜像引用**：用 Obsidian 原生 `^id` / `![[#^id]]` 块嵌入语法，同一节点可出现在多处并同步编辑；断链与循环引用降级为只读提示，绝不静默删除原文。
- **中文 IME**：合成期间不触碰编辑中节点的 DOM。
- **撤销 / 重做**：直接转发给 VS Code 原生 undo 栈，与文本编辑器共用一套历史。

### 保证

- **字节级 round-trip 幂等**：未编辑的行原样保留，包括缩进单位、行尾（CRLF/LF）、frontmatter、代码块和非列表内容。
- **最小 diff**：一次编辑只改对应的那几行，不重排整个文件。
- **UI 状态不落盘**：折叠、zoom、搜索一律存在 VS Code 里。
- 性能红线（5000 节点基准，随 CI 跑）：解析 < 20ms、首帧 < 500ms、击键 JS < 16ms、外部改动增量 patch < 50ms。
