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
| ` ``` ` / ` ```lang ` + `Enter` | 空的顶层根节点 → 文档级代码块（`toCodeBlock`，见 02/04）；**其余节点 → 代码块挂到该节点下**（`setText('')` + `setNote(围栏)`，一次 `dispatchAll`） |
| `/`（词首） | 打开斜杠插入菜单（见下「斜杠插入菜单」）：Code / To-do / 编号 |
| `Alt+→` / `Alt+←` | zoom in 当前节点 / zoom out 一级 |
| `Cmd/Ctrl+.` | 折叠/展开当前节点 |
| `↑` / `↓`（在首/末行） | 光标移到可见前/后节点（列尽量保持） |
| `Shift+↑` / `Shift+↓`（在首/末行） | 进入 / 扩展节点多选（见下「多选」） |
| `Cmd/Ctrl+Z` (+Shift) | undo/redo 转发（见上） |
| `Cmd/Ctrl+F` | 聚焦插件内搜索框（过滤式搜索，不用 VS Code find widget） |
| `Ctrl+O`（mac）/ `Ctrl+Alt+O`（其他） | 隐藏 / 显示已完成。webview 的按键会被转发给工作台做快捷键解析，只能挑 VS Code 没占的组合——已被实机否掉两轮：`Cmd+O` = 「打开文件」、`Cmd+Alt+O` = Remote 扩展「Open Remote Window」。Windows/Linux 上 `Ctrl+O` 才是「打开文件」，故分平台。平台由 host 注入 `<html data-platform>`（**不嗅探 UA**：Playwright 的 Chromium 在 macOS 上报 Windows UA）。判定用 `e.code === 'KeyO'`，不受 Option 改字符 / 布局影响；监听挂 document 级（BUG-002） |
| `Esc` | 退出多选 / 清除搜索 / 取消拖拽 / **退出代码块回到节点正文** |
| 代码块内 `↑` / `↓`（首/末行） | 回本节点正文 / 去下一个可见节点。**其余方向键与回车一律留给 textarea**：大纲 keymap 不认识 textarea 的行结构，中间行按 ↓ 会把光标弹到别的节点（见 main.ts `CODE_LOCAL_KEYS`） |

结构 op dispatch 前一律先 flush 待发的 setText（见 04 防抖策略）。

## 多选（selection.ts）

Workflowy 式的节点多选。**纯 webview UI 状态**：不写文件、不改协议、不新增 op。

- **进入**：`Shift+↑/↓` —— 判据与 `↑/↓` 跨节点移动相同（在首/末视觉行才接管），节点内还能扩文本选区时让给浏览器；或 `Shift+点击`另一个节点选中区间（同节点内的 Shift+点击仍是扩文本选区）。
- **退出**：`Esc`、打字（`input`）、任意普通鼠标按下（挂 document 级，点侧栏/工具条也退出）、`Cmd/Ctrl+Z`（undo 会重塑整棵树）。
- **选区语义**：锚点与活动端在 `store.visibleRows()` 先序里的闭区间，再**归一到子树根**（祖先已入选则后代被吸收）。批量 op 只作用在根上，子树自然跟着走。
- **批量操作**（复用既有 op，顺序有讲究）：

  | 按键 | op | 顺序 |
  |---|---|---|
  | `Tab` | `indent` × n | 文档先序 |
  | `Shift+Tab` | `outdent` × n | **逆序**（outdent 插到原父之后，正序会颠倒相对顺序） |
  | `Alt+↑` | `moveUp` × n | 文档先序 |
  | `Alt+↓` | `moveDown` × n | **逆序**（否则靠前的一项先跨过靠后的） |
  | `Cmd/Ctrl+Enter` | `setChecked` × n | 全已完成 → 全取消，否则全标完成 |
  | `Backspace` / `Delete` | `delete` × n | 光标落到选区前一行，无前一行则落到选区后第一行 |
  | `Cmd/Ctrl+C` / `X` | —（cut 追加 `delete` × n） | 见剪贴板 |

  一次批量走 `store.dispatchAll(ops)` → **一条 edit 消息** = host 一次 `applyEdit` = **一个 undo 步**（见 04）。no-op 的 op 不入队（如首个兄弟的 `indent`）。
- **高亮**：只给子树根打 `.selected`，CSS `.node.selected .node-row` 让整棵子树跟着高亮——与批量 op 的作用范围一致。只增删 class、不动 DOM；无选区时 `syncHighlight` 立即返回（护住 refresh 红线，见 07）。
- **限制**：镜像视图（复合 id `mirrorId/originalId`）不参与多选——那里的行不在数据层 `visibleRows` 里，区间语义无从定义。鼠标拖选（按住拖过多行）暂不支持。

### zoom 根标题的对齐

zoom 根渲染成页面标题：`toggle` 完全不占位（`display:none`）、`bullet` 占位但隐藏（`visibility:hidden`）——标题首字落在 `16 + 4(gap) + 2(padding) = 22px`，正好是子节点圆点的左缘（`toggle 14 + gap 4 + ::before left 4`）。两个都 `display:none` 会贴到容器最左，两个都 `visibility:hidden` 又比子节点还靠右，两版都被实机否掉过。

## 代码块（codeFence.ts + highlight.ts）

顶层代码块（文档级 RawBlock）与节点代码块（节点的 note 恰为围栏块）共用同一套渲染，差别只在 textarea 的 `data-field`（`code` → `setRawBlock`，`noteCode` → `setNote`）。

```html
<div class="raw-block code-block highlighted">
  <div class="code-head"><span class="code-lang">ts</span><button class="code-copy" data-action="copy-code">Copy</button></div>
  <div class="code-body">
    <pre class="code-hl" aria-hidden="true">…Prism token…</pre>   <!-- 高亮层，只读、不吃事件 -->
    <textarea class="code-input" data-field="noteCode"></textarea> <!-- 唯一的真实来源 -->
  </div>
</div>
```

- **高亮层压在透明文字的 textarea 之下**：textarea 内部无法着色，要「编辑时也有高亮」只有这一条路。两层的 **font-family / font-size / line-height / letter-spacing / tab-size / padding / border / white-space 必须逐条一致**，差一条整块代码就重影（`code-highlight.spec.ts` 逐条断言）。长行横向滚动时把 `scrollLeft` 同步给高亮层（`scroll` 不冒泡，挂捕获阶段）。
- **打字热路径只重画高亮层**（`syncHighlight`），绝不重建代码块 DOM——重建会打断输入。
- **语言支持**：Prism 打进 bundle（CSP 只放行本扩展资源，绝不外链 CDN）。**语言集受性能红线约束**：打包的语法越多，5000 节点的外部 refresh patch 越贴近 50ms 红线（实测见 07），所以只装常用的一批（core 自带 markup/css/javascript/clike + typescript/json/python/bash/go/rust/sql/yaml）。识别不了的语言不建高亮层（`canHighlight`），退化成纯 textarea，功能不受影响。**加语言前必须按 09 单独串行复测 perf。**
- **配色**走主题变量 `--vscode-charts-*`（终端 ANSI 兜底），不写字面色——`theme.test.ts` 守着这条。代价是两组变量都缺时高亮整块退化成纯文本。
- **复制按钮**发 `copyText` 给 host 走 `vscode.env.clipboard`（见 04），不用浏览器剪贴板 API。
- **头部（语言徽标 + 复制按钮）绝对定位在代码块右上角，不占布局高度**——占一行会把「块排进节点行」的成果顶掉、代码块上方又冒出一条空行（实机反馈两轮）。
- **语言徽标就是切换语言的入口**：围栏行被渲染层摘掉了，没有这个入口语言就永远改不了。切换时只改 `data-code-open` 里的语言部分，**保留原缩进与围栏字符**（``` / ~~~ 及其长度，字节保真红线），随后走和编辑代码同一条提交路径，不新增 op。因为 `setNote` / `setRawBlock` 是不 emit 的热路径，切换后要**本地立即 `renderFence` 重建这一块**（换语言要加/删高亮层，只改徽标文字不够）。
- **退出手势要看正文是否为空**：`Esc` / 首行 `↑` 本来一律回「本节点正文」，但代码块节点的正文是空的、零宽——聚焦它只会在代码块旁冒出一条空输入框，像 bug（实机反馈）。正文为空时改去相邻节点（优先上一个）。
- **行内挂载的代码块放在正文之后**（`syncNoteCode` 用 `append` 而非 `insertBefore`）：正文为空时零宽、看不出差别；一旦正文获得焦点（如从上一个节点按 `↓` 进来），它占住 bullet 右边这一行、代码块折到下一行并缩进 38px 对齐正文列——像个标题栏。反过来（块在前）焦点一来就在块下方冒出空输入框。
- **`Tab` / `Shift+Tab` 在节点代码块里缩进的是「这个节点」**，不是代码文本：代码块节点的正文宽度为 0、点不到，Tab 又是全 app 统一的层级手势，此前 Tab 只把焦点甩走 = 没有缩进入口（实机反馈）。代码内缩进打空格。顶层代码块没有层级，Tab 插两个空格。

## 剪贴板（clipboard.ts）

- **paste**：`preventDefault()`；先看剪贴板里有没有图片：
  - **图片** → 生成唯一文件名，经 store 在光标处插入 `![[<assetsDir>/name]]`（**不用 `execCommand`**：它在 VS Code webview 里对 `plaintext-only` 静默失败，图写了盘正文没引用，真机复现过），并发 `saveImage{name, dataBase64}` 让 host 写盘（见 04）。落盘目录是 host 注入的 `data-assets-dir` = `<文件名去扩展名>/assets`，不再撒在笔记同级目录；
  - 否则取 `clipboardData.getData('text/plain')`：多行且含列表语法 → 复用 **core parser** 解析出子树发 `insertSubtree`；多行无列表语法 → 按行拆为兄弟节点发 `insertSubtree`；单行 → 插入 caret 处走 `setText`。
- **copy/cut**：**多选优先**——选区非空时把选中的全部子树序列化成一份 markdown 列表（cut 再整段 `delete`）；否则退回单节点：选中文本走浏览器默认，光标所在节点则序列化整棵子树（复用 core serializer），与外界互粘闭环；cut 追加 `delete` op。

## 图片（images.ts + lightbox.ts）

- **预览**：正文里的 `![alt](path)` / `![[file.ext]]` 渲染成 `.node-images > img.node-image`，源码仍在可编辑正文里。相对路径按 `data-doc-base`（host 注入）改写成 `vscode-webview://`。
- **块内容进节点行**（图片 / 代码块共用的规矩）：一个节点的内容如果**只有**这个块（正文为空或只有图片语法），块就挂进 `.node-row` 里；否则挂在行下方。否则块上面会多出一条只有 bullet 的空行（实机反馈两次）。
- **图片节点**：正文除图片语法外没有别的内容时（`isImageOnly`），`.node-row` 加 `.image-only`：
  - 预览**挂进节点行内**（`syncImages` 把 `.node-images` 插到 `.text` 之前），图片就是这一行的内容，上方不再多出一条空行；正文有字的节点仍挂在行下方。
  - 未聚焦时 `.text` 透明。刻意**不用 `display:none`**：那样 `restoreCaret` 与点击都聚焦不上，节点会变成改不动的死块。透明的正文仍是图片右侧的点击区，点它即回源码态。
  - 必须配 `white-space: nowrap; overflow: hidden`——**透明 ≠ 不占位**，长 data: URI 源码会换行把整行撑到几十像素高（实机看到的怪空行就是它）。
- **放大预览**：点 `img.node-image` → `openLightbox`（全屏浮层，点浮层任意处 / `Esc` 关闭）。纯渲染层，不发消息。**关闭时把光标送回该图片所在节点正文末尾**（`onLightboxClosed`）——否则「点图 → Esc」之后焦点悬空，图片节点没有键盘出口，连建个同级节点都做不到（实机反馈）。
- **孤儿清理**：**不挂在「删节点」上**（删节点可 undo、删文件不可，一耦合 undo 回来就是「正文在、图没了」）。两条入口，都只在本文档自己的 assets 目录里动手：
  - **保存时自动**（`outlineNode.cleanupUnusedImagesOnSave`，默认开）：只删扩展自己生成的 `pasted-*` 孤儿，移废纸篓，状态栏提示 4 秒。延到保存 = 给 undo 留窗口（撤销后再保存，引用回来了就不算孤儿）。
  - **显式命令** `outlineNode.cleanupImages`：该目录下所有未被引用的图片，带确认弹窗。
  - 已知局限：判据是「本文档是否引用」，所以从别的笔记引用本文档 assets 里的图会被当成孤儿。

## 代码块编辑（nodeView.ts + main.ts 委托）

围栏代码块 RawBlock 渲染为语言标签 + 可编辑 `textarea`（`data-field="code"`），元素上带 `data-block-id`（renderer 注入）。textarea `input` 经 main.ts 委托重建整块行（保留 `data-code-open` / `data-code-close` 原始围栏）→ `store.setRawBlockLines` → `setRawBlock` op（热路径不重渲染，同 setNodeText）。正在编辑本块时 `updateRawBlockView` 一票跳过（`el.contains(document.activeElement)`），不打断输入。创建见快捷键表 ` ``` ` 行。

**节点代码块**（`.node > .node-code`）：节点的 `note` 整体是围栏块时，`syncNote` 渲染成同一套代码块 UI（`data-field="noteCode"`），编辑经 `setNote` 整块替换。围栏解析/渲染由 `codeFence.ts` 与文档级代码块共用，两条路径只差 textarea 的 `data-field`。这就是「节点下面挂代码块」——见 02，**不需要新 op**。

- 新建时写 `` ```lang\n``` ``（**不留空正文行**：那会被序列化成一行缩进空白）。
- **正文为空的「代码块节点」**：`.node-row` 加 `.code-only`，代码块挂进行内（`syncNoteCode` 插到 `.text` 之前），块上方不再留空 bullet 行；正文有字时仍挂在行下方。空正文缩成零宽点击区，聚焦时靠 `flex-wrap` 折到块下方单独成行。
- 代码正文里的空行没问题，parser 侧已支持（见 03「note 续行」的围栏例外）。
- `note` 被删掉时 `syncNote` 无条件摘除代码块 DOM——此刻焦点还在该 textarea 里，照搬「正在编辑就不动」的守卫会让它赖着不走。

**出口手势**（代码块容易变死胡同）：keymap 对 textarea 不生效（`saveCaret` 返回 null），故在 main.ts 的 root keydown 里单独处理——

| 手势 | 文档级代码块 | 节点代码块 |
|---|---|---|
| `Cmd/Ctrl+Enter` | 其后新建顶层节点（`insertRootAfterBlock`，BUG-003） | 其后新建同级节点（`insertSubtree`） |
| 空块 `Backspace`/`Delete` | 删掉整块（`deleteRawBlock`，BUG-004） | `setNote(null)` 摘掉代码块，光标回正文末尾 |

非空时不触发（正常删字符），要删有内容的块先清空正文。

## 斜杠插入菜单（slashMenu.ts）

Workflowy 式 `/` 菜单：在正文（`text` 字段）词首（行首或空白后）输入 `/` 弹出可过滤菜单，`/` 后连续非空白串为 query。↑↓ 选、Enter/Tab 确认、Esc 忽略（同一 token 不再自动弹）、光标移出 token 或失焦即关。菜单由 `input` 委托在 `setNodeText` 之后 `sync()` 重算；`keydown` 在 keymap 之前拦导航键（激活且有匹配时）。

条目复用现有 op、不改数据模型：

- **Code block**：两条路径。去掉 `/token` 后为空的**顶层无子节点** → `toCodeBlock`（文档级，文件里没有 bullet，`/code` 文本随节点一并消失）；**其余节点** → `setText(去掉 token)` + `setNote(围栏)` 挂到该节点下。`enabled` 只排除「已有备注」与镜像节点（note 只有一份，代码块会顶掉原备注）。
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

`vscode.setState` 持久化 `{ zoomRootKey, scrollTop, hideCompleted, sidebarCollapsed, sidebarSections }`（zoom 存 nodeKey 而非 id）。webview revival → `ready` → 收到 `init` → 按 state 恢复 zoom/滚动/隐藏已完成/侧栏。全是 UI 态，只进 `setState`，绝不写 `.md`（红线 3）。

## 侧栏（sidebar.ts）

- 结构：`Starred`（有书签时才出现）→ `Home` + 其下的可展开大纲树。**`Home` 就是大纲区的标题行**：三角折叠整区、文字点击回全文档、zoom 在根时自身高亮——刻意不再单列一行 Home 再加一个 Outline 小标题（实机反馈：同一含义占两行）。分区标题都是折叠开关（`aria-expanded`），折叠键 `'starred'` / `'outline'` 随 `ViewState.sidebarSections` 持久化——收起 Starred 即可消掉「同一节点在两区各列一次」的重复观感。
- 缩进基准 `INDENT_BASE_PX = 17`（sidebar.ts）必须与 `.sidebar-item` 的 `padding-left: calc(17px + depth * 13px)` 一致：拖拽落点深度就是用横向像素反算的，改一处必须改另一处（测试 `dragSidebar` 里也有一份）。
- 侧栏树的展开状态独立于主编辑区折叠，只存 webview 内存；渲染项封顶 `MAX_ITEMS`，护住 refresh patch 的性能红线（见 07）。
- 观感约定：`Starred` 与 `Home` 是并列的一级入口，**必须同字号、同字重、同行高、同三角位**（两者排版不一致会立刻显得「样式不对」，实机否掉过一版）；当前位置用「淡底 + 左侧 2px 竖条 + 字重」，不用通栏 `list-activeSelectionBackground` 色块；星标/三角默认低透明度，hover 才提亮；层级除缩进外每级再降 12% 不透明度（最多两级）。颜色一律走 `--vscode-*`（见本文档开头的主题约定）。
