# 05 — Webview UI 规格（src/webview/*）

原生 TypeScript，无框架。所有交互模块只调 `store.dispatch(op)` 或改 UI 状态，不直接 postMessage、不直接改树。

## DOM 结构（nodeView.ts）

每个 OutlineNode 对应：

```html
<div class="node" data-id="{id}">
  <div class="node-row">
    <button class="toggle" aria-expanded="true|false"></button>   <!-- 有子节点才显示 -->
    <div class="bullet"></div>                                    <!-- 点击 = zoom in；拖拽把手 -->
    <div class="text" contenteditable="plaintext-only"></div>
    <span class="block-id-badge"></span>                          <!-- blockId 存在时显示小图标，text 中不显示 ^id -->
  </div>
  <div class="note" contenteditable="plaintext-only"></div>       <!-- note 非 null 才挂载 -->
  <div class="children"></div>                                    <!-- 子节点容器；折叠时整个不挂载 -->
</div>
```

RawBlock 渲染为只读灰色卡片 `<pre class="raw-block">`（可整块视觉折叠，不参与任何大纲操作）。仅含空行且两侧都是 ListBlock 的 RawBlock 渲染为细分隔（视觉连续，见 03）。

- 完成节点（`checked === true`）：`.node-row` 加 `.checked`，灰色 + 删除线。
- 文本读写：text div 用 `textContent`（单行）；note div 用 `innerText`（保留换行）。
- 样式全部基于 `--vscode-*` CSS 变量（`--vscode-editor-background`、`--vscode-editor-foreground`、`--vscode-focusBorder` 等），自动适配明暗主题，禁止硬编码颜色。

## 渲染（renderer.ts）— keyed 增量 patch

```ts
export class Renderer {
  patch(doc: DocSnapshot, opts?: { dirtyIds?: Set<string> }): void;
}
```

- 维护 `Map<id, HTMLElement>`。patch 时逐节点比对 `text/checked/note/子序列`，只更新变化的节点；子节点顺序变化用 `insertBefore` 移动**现存**元素，绝不整树重建。
- **第一原则：正在编辑（focus 所在）且文本未变的节点跳过一切 DOM 操作**——原生光标根本不动，这是光标稳定的根基。
- 折叠子树**不构建 DOM**（不是 display:none），展开时惰性构建（见 07）。
- 统一入口：所有重渲染必须走 `renderer.patch`，patch 前 `caret.save()`、patch 后 `caret.restore()`（除非命中第一原则跳过）。

## 光标（caret.ts）

```ts
export interface CaretPos { nodeId: string; field: 'text' | 'note'; offset: number }
export function saveCaret(): CaretPos | null;      // 从 window.getSelection() 读取
export function restoreCaret(pos: CaretPos): void; // offset clamp 到新文本长度；节点不存在 → 落到树中最近邻居
```

`contenteditable="plaintext-only"` 下每个 div 内是单个 text node（或空），offset 即字符偏移，无富文本 Range 复杂度——这是选 plaintext-only 的核心收益之一（另一收益：天然杜绝富文本粘贴）。webview 是 Chromium，`plaintext-only` 稳定支持。

## IME 守卫（ime.ts）— 红线 4

```ts
export const ime = { composing: boolean, pendingRefresh: H2W | null };
```

- `compositionstart` → `composing = true`。期间：
  - store 不发出 `setText`（input 事件忽略）；
  - 收到的 `refresh` 不应用，存入 `pendingRefresh`（只保留最新一条）；
  - keydown 中 `e.isComposing || e.keyCode === 229` → 直接 return，把 Enter/Esc 让给输入法，绝不执行结构操作；
  - **该节点的 DOM 绝对不被触碰**（renderer 对 focus 节点的跳过原则在此期间无条件生效）。
- `compositionend` → `composing = false`；读 `textContent` 走正常 setText 防抖；然后应用 `pendingRefresh`。

这是中文输入不丢字的充分条件。playwright 用 CDP `Input.imeSetComposition` 覆盖测试（见 09）。

## Undo 三道闸（红线 5）

1. `beforeinput` 监听 `inputType === 'historyUndo' | 'historyRedo'` → `preventDefault()`（封死浏览器 undo 栈的一切入口，含右键菜单/系统菜单触发）；
2. keydown `Cmd/Ctrl+Z`（+Shift = redo）→ `preventDefault()` → `store.flushPending()` → postMessage `requestUndo`/`requestRedo`；
3. host 执行 `vscode.commands.executeCommand('undo')` 作用于 TextDocument → 变化以 `refresh{cause:'undo'}` 推回，patch 后按 id 恢复光标。

## 快捷键表（keymap.ts）

统一在容器上监听 keydown（事件委托）。`e.isComposing` 一票否决（见 IME）。

| 按键 | 语义 |
|---|---|
| `Enter` | 光标处拆分：`split{id, offset, newId}`；特例——节点展开且有子节点且光标在行尾 → `insertSubtree{parentId:id, index:0, nodes:[空节点]}`（新建第一个子节点，Workflowy 语义） |
| `Shift+Enter` | 聚焦/创建 note（note 为 null 时 `setNote{note:''}` 并挂载 div）；note 内 `Shift+Enter` 插入换行，`Enter` 回到 text |
| `Tab` / `Shift+Tab` | `indent` / `outdent`（preventDefault，光标偏移保持） |
| `Backspace`（offset 0） | 有前驱 → `mergeWithPrevious`（dispatch 前记录 junction offset 恢复光标）；无前驱（首节点）且为空节点 → `delete` 该节点、光标移到下一个可见节点（Workflowy 语义）；无前驱且非空 → no-op（不丢正文）；文档仅剩一个节点时不删 |
| `Alt+↑` / `Alt+↓` | `moveUp` / `moveDown` |
| `Cmd/Ctrl+Enter` | `toggleChecked` |
| ` ``` ` / ` ```lang ` + `Enter` | 空的顶层根节点 → 顶层代码块（`toCodeBlock`，见 02/04）；非顶层节点上不触发，`Enter` 按普通逻辑走 |
| `/`（词首） | 打开斜杠插入菜单（见下「斜杠插入菜单」）：Code / To-do / 编号 |
| `Alt+→` / `Alt+←` | zoom in 当前节点 / zoom out 一级 |
| `Cmd/Ctrl+.` | 折叠/展开当前节点 |
| `↑` / `↓`（在首/末行） | 光标移到可见前/后节点（列尽量保持） |
| `Cmd/Ctrl+Z` (+Shift) | undo/redo 转发（见上） |
| `Cmd/Ctrl+F` | 聚焦插件内搜索框（过滤式搜索，不用 VS Code find widget） |
| `Esc` | 清除搜索 / 取消拖拽 |

结构 op dispatch 前一律先 flush 待发的 setText（见 04 防抖策略）。

## 剪贴板（clipboard.ts）

- **paste**：`preventDefault()`；先看剪贴板里有没有图片：
  - **图片** → 生成唯一文件名，`execCommand('insertText')` 在光标处插入 `![[name]]`（走和手打一致的路径），并发 `saveImage{name, dataBase64}` 让 host 写盘（见 04）；
  - 否则取 `clipboardData.getData('text/plain')`：多行且含列表语法 → 复用 **core parser** 解析出子树发 `insertSubtree`；多行无列表语法 → 按行拆为兄弟节点发 `insertSubtree`；单行 → 插入 caret 处走 `setText`。
- **copy/cut**：选中节点（或光标所在节点整棵子树）序列化为 markdown 列表写入剪贴板（复用 core serializer），与外界互粘闭环；cut 追加 `delete` op。

## 代码块编辑（nodeView.ts + main.ts 委托）

围栏代码块 RawBlock 渲染为语言标签 + 可编辑 `textarea`（`data-field="code"`），元素上带 `data-block-id`（renderer 注入）。textarea `input` 经 main.ts 委托重建整块行（保留 `data-code-open` / `data-code-close` 原始围栏）→ `store.setRawBlockLines` → `setRawBlock` op（热路径不重渲染，同 setNodeText）。正在编辑本块时 `updateRawBlockView` 一票跳过（`el.contains(document.activeElement)`），不打断输入。创建见快捷键表 ` ``` ` 行。

## 斜杠插入菜单（slashMenu.ts）

Workflowy 式 `/` 菜单：在正文（`text` 字段）词首（行首或空白后）输入 `/` 弹出可过滤菜单，`/` 后连续非空白串为 query。↑↓ 选、Enter/Tab 确认、Esc 忽略（同一 token 不再自动弹）、光标移出 token 或失焦即关。菜单由 `input` 委托在 `setNodeText` 之后 `sync()` 重算；`keydown` 在 keymap 之前拦导航键（激活且有匹配时）。

条目复用现有 op、不改数据模型：

- **Code block**：`toCodeBlock`。受纯 Markdown 红线限制**只能顶层空节点**——`enabled` 用 `locationOf().parentId === null` 且无子/备注/镜像过滤；不合格时该条不出现（嵌套节点 `/code` 显示"无匹配"，Enter 放行为普通拆分）。转换时 `/code` 文本随节点整体被替换成代码块 RawBlock，无需单独删。
- **To-do**：先 `setText` 删掉 `/query`，再 `setChecked{checked:false}`（未勾选任务）。用 `setChecked` 而非 `toggleChecked`，因为后者从 `null` 只能到 `true`（见 04）。
- **Numbered**：先 `setText` 删掉 `/query`，再 `toggleOrdered`（已是有序则跳过）。

无匹配时只显示占位、不拦截 Enter。所有条目文案走 `t()` 双语（见 i18n.ts `slash.*`）。

## 拖拽（dnd.ts）

用 **pointer events** 自实现（不用 HTML5 DnD：ghost 图像与 drop 目标控制太差）：

- 按下 `.bullet` + 移动超过 4px 阈值 → 进入拖拽；被拖子树加半透明样式。
- 移动中计算插入间隙（相邻两行之间），显示 drop 指示线；**指针水平偏移决定目标深度**——在该间隙的合法深度区间内（上行深度+1 ~ 下行深度）按缩进宽度换算。
- 松开 → 单条 `move{id, parentId, index}`；Esc 取消。
- 容器边缘 40px 内自动滚动。
- v1 限制：同一 ListBlock 内拖拽（跨 block 禁止落点）。

## 搜索（search.ts）

- 顶部固定搜索框，输入 150ms 防抖。
- 过滤规则：命中节点 + 其全部祖先显示，其余加 `.hidden` class；**不动 DOM 结构**（性能，见 07）。命中节点整行背景高亮（v1 不做子串级 `<mark>` 高亮——与 plaintext-only 的单 text node 模型冲突，留给后续用 overlay 层实现）。
- 匹配：大小写不敏感子串，命中 `text` 与 `note`。
- 清空/Esc → 移除所有 `.hidden`，恢复折叠状态原样。

## Zoom（zoom.ts）

- `zoomRootId: string | null`（null = 全文档）。zoom 状态下 renderer 只渲染该子树（见 07）；节点自身显示为页面标题（可编辑，仍是同一节点）。
- 面包屑：根 → … → 当前 zoom 节点的链路，每级可点击跳转；`Alt+←` 上跳一级。
- 入口：点击 bullet、`Alt+→`。
- 持久化：`vscode.setState({ zoomRootKey })`——存 nodeKey（见 06）而非 id（id 不跨 session），热恢复后解析回节点。

## 热恢复（main.ts）

`vscode.setState` 持久化 `{ zoomRootKey, searchQuery, scrollTop, caret: CaretPos | null }`（caret 中 nodeId 换存 nodeKey）。webview revival → `ready` → 收到 `init` → 按 state 恢复 zoom/搜索/滚动/光标。
