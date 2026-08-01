# 06 — 折叠状态存储 与 镜像引用

## 一、折叠状态（extension/foldingStore.ts + core/nodeKey.ts）

### 决策：`workspaceState`（Memento），坚决不写文件

文件内标记（HTML 注释、附加属性等）会污染 Git diff，并在 Obsidian 里显形——直接否决（红线 3）。代价（换机器/删 workspace 缓存后折叠态丢失）完全可接受。

### 存储结构

```ts
export class FoldingStore {
  constructor(state: vscode.Memento);           // context.workspaceState
  load(uri: vscode.Uri): string[];              // foldedKeys
  save(uri: vscode.Uri, foldedKeys: string[]): void;
}
```

- key = `folding:${uri.toString()}`，value = `{ keys: string[], t: number }`（t = 最近访问时间戳，用于 LRU）。
- 上限：LRU 保留 200 个文件；单文件最多 2000 个 key（超出丢弃最深层的）。防 Memento 膨胀。
- 配置：`outlineNode.rememberFolding`（默认 true）；`outlineNode.defaultFold: 'none' | 'firstLevel'`（无记录时的初始折叠）。

### nodeKey 生成（core/nodeKey.ts）

```ts
export function nodeKey(node: OutlineNode, occurrenceIndex: number): string;
// node.blockId 存在 → `b:${blockId}`
// 否则           → `h:${hash36(node.text)}` + (occurrenceIndex > 0 ? `#${occurrenceIndex}` : '')
```

- `hash36` = 快速非加密哈希（如 FNV-1a / xxhash32）转 base36 短串。
- `occurrenceIndex` = 同哈希节点在文档先序中的序号（0 起），解决重复文本碰撞。
- **刻意不掺入祖先路径**：move/indent/拖拽后 key 不变 → 折叠保留；只有 rename 使 key 失效。有 `blockId` 的节点连 rename 都免疫。

### 生命周期（韧性设计）

- session 内折叠状态挂在**内存 id** 上（webview store 持有 `foldedIds: Set<string>`），编辑期间永不丢。
- 落盘时机：webview 折叠变化时节流（2s）发 `saveFolding{foldedKeys}`（id → nodeKey 映射由 webview 按当前树计算）；session `dispose` 时强制保存。
- 打开文件：host `load` → 随 `init` 下发 `foldedKeys` → webview 按 nodeKey 反查节点标记折叠。
- 外部修改走 `treeMatch` 复用旧 id → 折叠自然存活。唯一丢失场景：**rename 无 blockId 的节点 + 关闭再重开文件**，可接受。

## 二、镜像引用（webview/mirror.ts + parser 支持）— 放在最后一个功能里程碑实现

### 纯文本约定（Obsidian 最大兼容）

| 角色 | 语法 | 示例 |
|---|---|---|
| 原节点 | 行尾 Obsidian 原生 block id | `- 写周报 ^k3f9a2` |
| 镜像节点 | Obsidian 块嵌入语法（正文恰为此） | `- ![[#^k3f9a2]]` |

- v1 仅支持**同文件**镜像；跨文件语法 `![[note#^k3f9a2]]` 预留不实现。
- **选择理由**：两者都是 Obsidian 原生语法——在 Obsidian 里打开同一文件，镜像位置会**真实内联渲染原块内容**，互通是"语义等价"而非"不报错"；且 Obsidian 对指向 list item 的块嵌入会嵌入整个子树，恰好匹配本项目镜像引用包含子树的语义。**不选 Logseq `((uuid))`**：非通用 markdown 语法，Obsidian 无法解析。
- blockId 生成：创建镜像时若原节点无 blockId，自动生成 6 位 base36 随机 id（文档内查重），通过 `setText` 之外的专用途径写入——实现为 op 扩展 `{ op: 'assignBlockId'; id: string; blockId: string }`（加入 04 的 Op 全集，语义：设置 blockId，raw 置 null）。

### 数据层：单份数据，渲染层展开

- parser 把行尾 `^id` 剥离存入 `blockId`（text 中不含，渲染时显示小徽标，见 05）。
- 正文恰为 `![[#^id]]` 的节点解析为 `mirror = id`；模型不变式：mirror 节点 `children` 恒空、`note` 恒 null（文件里镜像行下的缩进内容按普通子节点处理会破坏语义——parser 遇到镜像行带子行时，子行按正常子节点解析但渲染层忽略并在 UI 提示；序列化原样保留，不丢数据）。
- **渲染**（mirror.ts）：镜像节点按 `mirror` id 查找原节点，把原子树渲染为"第二个视图"；视图内每个 DOM 节点使用复合 id `${mirrorNodeId}/${originalId}`（保证 renderer 的 keyed Map 不冲突）。
- **编辑同步零成本**：镜像视图内的任何编辑，dispatch 前把复合 id 重写回原始 id → 数据层始终只有一份 → 原视图与所有镜像视图在下一次 patch 自然一致。文件里只有原文一份 + N 行引用，diff 最干净。
- 镜像视图内禁用的操作：indent/outdent/move 出镜像子树边界（结构操作限制在原子树内部语义下进行）。

### 边界情况

- **环检测**：展开镜像视图时维护祖先 blockId 集合，遇到已在集合中的引用 → 渲染占位符「循环引用」，不展开。
- **断链**：`mirror` 指向的 blockId 不存在 → 渲染为断链样式的普通只读行（保留原文 `![[#^id]]`，不静默删除、不丢数据）。
- **删除原节点**：所有指向它的镜像行自动变为断链样式（数据层不动镜像行）。
- **创建入口**：节点右键菜单「Copy as mirror link」把 `![[#^id]]` 写入剪贴板（必要时先 assignBlockId）；粘贴到目标位置即成镜像。
