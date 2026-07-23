# 01 — 总体架构

## 架构图

```
┌─────────────── Extension Host (Node) ────────────┐   ┌──────────── Webview (Chromium) ─────────┐
│ TextDocument（唯一事实源）                          │   │ store.ts（UI 树，乐观更新）                │
│   ↕ WorkspaceEdit / onDidChangeTextDocument      │   │   ↕ dispatch(op)                        │
│ DocumentSession（同步协议 host 侧，每 panel 一个）   │◄──┤ renderer.ts（keyed 增量 patch）           │
│ OutlineEditorProvider（CustomTextEditorProvider）├──►│ nodeView（contenteditable / 节点）        │
│ FoldingStore（workspaceState Memento）            │   │ keymap / caret / ime / clipboard /      │
└──────────────────┬───────────────────────────────┘   │ dnd / search / zoom / mirror            │
                   │            postMessage            └─────────────────────────────────────────┘
                   └── src/core/ 纯 TS 共享层（model/parser/serializer/ops/treeMatch/lineDiff/nodeKey）
                       零 vscode / 零 DOM 依赖，两端打包时各自引入同一份代码
```

## 设计基石

1. **TextDocument 是唯一事实源。** Webview 里的树只是文档的投影 + 乐观更新缓冲。所有持久化、undo/redo、脏标记、保存、热恢复都由 VS Code 的文本文档机制免费提供，本项目一行都不自己实现。
2. **`src/core/` 是纯逻辑共享层。** parser/serializer/ops 等无 vscode、无 DOM 依赖，extension host 和 webview 各自打包引入同一份代码。收益：两端树模型行为严格一致（乐观更新不会漂移）、core 可用 vitest 秒级单测、round-trip 可被 property test 覆盖。
3. **Webview 与 host 之间只传语义 op 和快照**（见 `04-sync-protocol.md`），不传全文、不传 DOM diff。

## 目录结构

```
23-OutlineNode/
├── package.json                  # contributes 见下文
├── tsconfig.json                 # base；core/extension/webview 各自 tsconfig 继承（webview 带 DOM lib，extension 带 node types）
├── esbuild.mjs                   # 双入口构建脚本，见下文
├── .vscodeignore  .gitignore  LICENSE  README.md  CHANGELOG.md  AGENTS.md
├── .github/workflows/
│   ├── ci.yml                    # lint + vitest + playwright + xvfb 集成测试 + vsce package（产物上传）
│   └── release.yml               # push tag v* → 测试 → vsce publish + ovsx publish
├── media/                        # icon.png, demo.gif
├── docs/                         # 本规格文档集
├── src/
│   ├── core/                     # ★ 纯逻辑共享层（零 vscode / 零 DOM）
│   │   ├── model.ts              # OutlineDoc / Block / OutlineNode 类型（见 02）
│   │   ├── parser.ts             # parseOutline(text): OutlineDoc（见 03）
│   │   ├── serializer.ts         # serializeOutline(doc): string（见 03）
│   │   ├── indent.ts             # detectIndent(lines): IndentUnit | null（见 03）
│   │   ├── ops.ts                # Op 类型 + applyOp(doc, op)（见 04）
│   │   ├── treeMatch.ts          # matchTrees(oldDoc, newDoc)：外部修改后 id 对齐（见 04）
│   │   ├── lineDiff.ts           # minimalEdits(oldText, newText)（见 04）
│   │   └── nodeKey.ts            # 折叠持久化 key 生成（见 06）
│   ├── shared/
│   │   └── protocol.ts           # W2H / H2W 消息类型、DocSnapshot、EditorConfig（见 04）
│   ├── extension/
│   │   ├── extension.ts          # activate()：注册 provider（两个 viewType）/ 命令 / 配置读取
│   │   ├── outlineEditorProvider.ts  # CustomTextEditorProvider：webview HTML、CSP、生命周期
│   │   ├── documentSession.ts    # ★ 同步协议 host 侧（每 webviewPanel 一个实例）
│   │   └── foldingStore.ts       # workspaceState Memento 封装（见 06）
│   └── webview/
│       ├── main.ts               # bootstrap：acquireVsCodeApi、消息路由、getState/setState 热恢复
│       ├── store.ts              # ★ UI 树 + dispatch（本地 applyOp 乐观更新 + 发送队列）
│       ├── renderer.ts           # ★ keyed 增量渲染调度（见 05、07）
│       ├── nodeView.ts           # 单节点 DOM 构建：bullet/toggle/text/note/children（见 05）
│       ├── keymap.ts             # keydown → 语义 op（见 05 快捷键表）
│       ├── caret.ts              # 光标 save/restore（见 05）
│       ├── ime.ts                # composition 守卫 + pendingRefresh 队列（见 05）
│       ├── clipboard.ts          # 粘贴多行拆子树 / 复制子树为 markdown（见 05）
│       ├── dnd.ts                # pointer events 拖拽 + drop 指示线（见 05）
│       ├── search.ts             # 实时过滤（见 05）
│       ├── zoom.ts               # 聚焦 + 面包屑（见 05）
│       ├── mirror.ts             # 镜像视图展开（见 06，最后实现）
│       └── styles.css            # 全部基于 --vscode-* CSS 变量做主题适配
└── test/
    ├── unit/                     # vitest：parser/roundtrip/ops/lineDiff/session + fixtures/*.md
    ├── webview/                  # playwright：真实 DOM/键盘/IME（mock acquireVsCodeApi）
    └── integration/              # @vscode/test-electron 冒烟
```

## esbuild 双入口（esbuild.mjs）

两个独立 build：

| 入口 | 产物 | 关键配置 |
|---|---|---|
| `src/extension/extension.ts` | `dist/extension.js` | `format: 'cjs'`, `platform: 'node'`, `external: ['vscode']`, `bundle: true` |
| `src/webview/main.ts` | `dist/webview.js` + `dist/webview.css` | `format: 'iife'`, `platform: 'browser'`, `bundle: true`（css 经 esbuild loader 一并产出） |

- `--watch` 模式供 F5 调试；production 加 `minify: true` + `sourcemap: false`。
- `package.json` 的 `main` 指向 `./dist/extension.js`；`.vscodeignore` 排除 `src/`、`node_modules/`、`test/`、`docs/`，vsix 里只有 `dist/` + `media/` + 元文档。

## package.json contributes（关键片段）

**注意：`customEditors` 的 `priority` 是按 entry 生效而非按 selector 生效**，所以需要两个 viewType 注册到同一个 provider 实例：

```json
{
  "contributes": {
    "customEditors": [
      {
        "viewType": "outlineNode.outline",
        "displayName": "Outline",
        "selector": [{ "filenamePattern": "*.outline.md" }],
        "priority": "default"
      },
      {
        "viewType": "outlineNode.outlineOptional",
        "displayName": "Outline",
        "selector": [{ "filenamePattern": "*.md" }],
        "priority": "option"
      }
    ],
    "commands": [
      { "command": "outlineNode.openAsOutline", "title": "OutlineNode: Open as Outline" }
    ],
    "configuration": {
      "properties": {
        "outlineNode.defaultIndent": {
          "type": "string", "enum": ["2-space", "4-space", "tab"], "default": "2-space",
          "description": "新文件或无法从内容检测缩进时使用的缩进单位"
        },
        "outlineNode.rememberFolding": { "type": "boolean", "default": true },
        "outlineNode.defaultFold": { "type": "string", "enum": ["none", "firstLevel"], "default": "none" }
      }
    }
  }
}
```

- `outlineNode.openAsOutline` 实现：对当前活动编辑器的 uri 执行 `vscode.commands.executeCommand('vscode.openWith', uri, 'outlineNode.outlineOptional')`。
- README 指导用户用 VS Code 原生 `workbench.editorAssociations` 把特定目录的 `*.md` 关联到本插件，不自造关联机制。

## 模块职责边界（一句话版，细节见各专题文档）

| 模块 | 职责 | 禁区 |
|---|---|---|
| `core/*` | 树模型、解析、序列化、编辑语义、diff、id 对齐 | 不碰 vscode / DOM / 消息 |
| `shared/protocol.ts` | 消息与快照的类型契约 | 只有类型与纯函数守卫，无逻辑 |
| `extension/documentSession.ts` | edit 校验重放、回声抑制、外部修改推送、undo 转发、折叠读写 | 不碰 DOM 概念；不实现编辑语义（调 core） |
| `extension/outlineEditorProvider.ts` | webview 创建、HTML/CSP、session 生命周期 | 不处理业务消息（转交 session） |
| `webview/store.ts` | UI 树、乐观 applyOp、发送队列与防抖、选区/折叠/zoom/搜索状态 | 不直接操作 DOM |
| `webview/renderer.ts` + `nodeView.ts` | 树 → DOM 的 keyed 增量投影 | 不改树（只读 store） |
| `webview/keymap.ts` 等交互模块 | 用户输入 → store.dispatch(op) 或 UI 状态变更 | 不直接发 postMessage（走 store） |

## Webview HTML 与生命周期

- Provider 生成的 HTML：CSP `default-src 'none'; style-src ${cspSource}; script-src 'nonce-...'; font-src ${cspSource}`；引入 `dist/webview.js`（nonce）与 `dist/webview.css`。
- `retainContextWhenHidden: false`（省内存）。热恢复靠 `vscode.getState()/setState()`：webview 侧持久化 `{ zoomRootKey, searchQuery, scrollTop, caret }`，revival 后 `ready` → host 发 `init` → webview 恢复 UI 状态。
- 每个 webviewPanel 对应一个 `DocumentSession`；同一文档开多个 panel 时各 session 独立，通过文档变更事件自然互相同步。
