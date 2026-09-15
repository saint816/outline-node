# OutlineNode

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/outlinenode.outline-node?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=outlinenode.outline-node)

[English](README.md) · **简体中文**

**本地优先的大纲编辑器，直接运行在纯 Markdown 文件上。**

![OutlineNode demo](media/demo.gif)

你的笔记就是一份标准的 `.md` 缩进列表——Obsidian / Logseq 直接能读，Git diff 干净可读。**没有私有格式，没有账号，没有云端；卸载插件之后文件原样可读。**

## 功能

- **分隔线**：`/divider` 将空节点变为横线、有文字节点变为居中标题横线；`---` + Enter 快速创建。悬停可添加标题或转回普通节点。保存为 `- ***` 或标题后接缩进的 `***` 续行；其他 Markdown 阅读器显示标题与横线，不保证居中排版。已有备注、任务和镜像不提供转换。

- **无限层级大纲**：`Enter` 拆分节点、`Tab` / `Shift+Tab` 调整层级、`Backspace` 合并
- **折叠 / 展开**：折叠状态记在 VS Code 里，**绝不写进你的文件**
- **Zoom-in**：聚焦任意子树，配面包屑导航
- **完成标记**：`- [x]`，灰色删除线
- **节点备注**：`Shift+Enter` 展开第二行，按缩进续行存储
- **移动与拖拽**：`Alt+↑/↓` 移动，鼠标拖拽可跨层级
- **实时搜索过滤**：保留祖先链，搜索时自动穿透折叠
- **行内 Markdown**：阅读态直接渲染，编辑态在纯文本 DOM 上保留轻量语法高亮；链接工具会弹出标题与 URL 双输入框
- **代码块与图片**：代码高亮、语言切换、一键复制，超过 240px 自动收起；图片可直接粘贴到笔记自己的 `assets/` 目录并行内预览
- **侧栏与星标**：快速浏览、折叠和 zoom 到任意节点
- **多选**：批量缩进、移动、完成、删除、复制或剪切，并作为一个 undo 步撤销
- **镜像引用**：同一节点出现在多处并同步编辑，用的是 Obsidian 原生 `^id` / `![[#^id]]` 块嵌入语法
- **完整中文 IME 支持**；`undo` / `redo` 直接用 VS Code 原生的，不另造一套

## 快捷键

| 按键 | 作用 |
|---|---|
| `Enter` | 光标处拆分节点（在展开的父节点行尾则新建第一个子节点） |
| `Shift+Enter` | 聚焦 / 创建节点备注；备注内插入换行 |
| `Tab` / `Shift+Tab` | 缩进 / 反缩进 |
| `Backspace`（行首） | 与上一个节点合并；空父节点会提升子节点后删除自身 |
| `Cmd/Ctrl+Shift+Backspace` | 删除当前节点或多选节点（包含后代时二次确认） |
| `Alt+↑` / `Alt+↓` | 上移 / 下移节点（带整棵子树） |
| `Cmd/Ctrl+Enter` | 切换完成状态 |
| `Alt+→` / `Alt+←` | Zoom in 当前节点 / Zoom out 一级 |
| `Cmd/Ctrl+.` | 折叠 / 展开当前节点 |
| `↑` / `↓` | 在首 / 末行时跳到相邻节点 |
| `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z` | 撤销 / 重做（VS Code 原生） |
| `Cmd/Ctrl+F` | 聚焦大纲内搜索框 |
| `Shift+↑` / `Shift+↓` | 扩展节点多选范围 |
| `?` | 显示全部快捷键 |
| `Esc` | 清除搜索 / 取消拖拽 |

macOS 用 `Cmd`，Windows / Linux 用 `Ctrl`。

加粗、高亮等排版使用选中文字后出现的浮动工具条；隐藏 / 显示已完成节点使用顶部的 `✓` 按钮。它们不再占用 `Ctrl` / `Ctrl+Alt` 组合键，避免与 VS Code、输入法和系统快捷键冲突。搜索默认显示为图标，点击或按 `Cmd/Ctrl+F` 时向左展开；空搜索失焦后自动收起。

节点代码块必须填写标题，但创建入口始终可用：输入 `/code` 或空行输入围栏后回车即可创建；若尚无标题，光标会留在代码块上方始终可见的“标题必填”行。也可以直接输入“解析 YAML /code”。已有空标题文件同样显示可编辑提示，但不会擅自改写 Markdown。`/` 菜单只提供 Code，已有任务节点及完成状态操作不受影响。

## 使用

- **`*.outline.md`** 默认用 OutlineNode 打开。
- 普通 **`*.md`**：编辑器右上角 `⋯` → **Reopen Editor With… → Outline**，或命令面板运行 `OutlineNode: Open as Outline`。
- 想让某个目录（比如 Obsidian vault 里的 `outlines/`）下所有 `.md` 默认走大纲，用 VS Code 原生的 `workbench.editorAssociations`：

  ```jsonc
  {
    "workbench.editorAssociations": {
      "**/outlines/**/*.md": "outlineNode.outline"
    }
  }
  ```

  想改回文本编辑器，把这条删掉即可，文件本身不受任何影响。

## 与 Obsidian / Logseq 互通

文件里存的就是普通的 Markdown 缩进列表：

```markdown
- 本周计划 ^k3f9a2
  - 写周报
    - 收集数据
  - [x] 报销
    备注写在缩进续行里
- 引用上面那条：![[#^k3f9a2]]
```

- **Obsidian**：`^k3f9a2` 是块 id，`![[#^k3f9a2]]` 是块嵌入——在 Obsidian 里打开会真的渲染成嵌入块，语义等价。
- **Logseq / 其他大纲工具**：缩进列表是通用格式，直接可读。
- **Git**：一次编辑只产生对应那几行的 diff，不会把整个文件重排。

## 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `outlineNode.defaultIndent` | `2-space` | 新文件或无法检测缩进时用的缩进单位（`2-space` / `4-space` / `tab`） |
| `outlineNode.rememberFolding` | `true` | 是否记住折叠状态 |
| `outlineNode.defaultFold` | `none` | 打开时的默认折叠（`none` / `firstLevel`） |
| `outlineNode.cleanupUnusedImagesOnSave` | `true` | 保存后把 OutlineNode 生成且已无引用的 `pasted-*` 图片移到废纸篓 |

已有文件的缩进单位从内容里自动检测，不会被配置覆盖。

## 设计原则

1. **文件是唯一真相**：TextDocument 就是数据源，undo / 脏标记 / 保存 / 热恢复全部走 VS Code 原生机制。
2. **最小 diff**：只改你动过的那几行，不「顺手」格式化其余内容；未编辑的行字节级不变。
3. **UI 状态不落盘**：折叠、zoom、搜索一律存在 VS Code 里，你的 `.md` 永远干净。

## 开发

参见 [AGENTS.md](AGENTS.md)（贡献者 / 编码 agent 入口）与 [docs/](docs/)（完整技术规格）。

## License

MIT

内置的第三方代码：[Prism](https://prismjs.com/)（MIT）——代码块语法高亮。扩展的 CSP 不允许外链 CDN，所以它被打进 webview bundle。
