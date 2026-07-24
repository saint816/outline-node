# 02 — 数据模型（src/core/model.ts）

一切类型的源头。本文件定义的类型是全项目共享词汇，禁止重命名或私自扩展（改动需先改本文档）。

## 核心决策：文档是「块序列」而非纯树

一个 markdown 文件 = 若干 `Block` 的有序序列。列表段落是 `ListBlock`（树结构，可编辑），其余一切内容（frontmatter、标题、正文段落、代码块、空行）是 `RawBlock`（字节原样保留，只读渲染）。这是「与 Obsidian vault 互通」和「无损 round-trip」的关键：vault 里的文件几乎必然带 frontmatter，拒绝打开或强行转换都不可接受。

## 类型定义

```ts
// ---------- 文档 ----------
export interface OutlineDoc {
  blocks: Block[];
  indentUnit: IndentUnit;      // 检测或配置得到的缩进单位（见 03）
  eol: '\n' | '\r\n';          // 文档主导换行符，序列化时统一使用
  eofNewline: boolean;         // 原文件末尾是否有换行，序列化时保持
}

export type IndentUnit =
  | { kind: 'space'; width: number }   // 常见 2 或 4；检测结果为准，不 clamp
  | { kind: 'tab' };

// ---------- 块 ----------
export type Block = RawBlock | ListBlock;

export interface RawBlock {
  kind: 'raw';
  id: string;          // session 内稳定 id（nanoid），不落盘
  lines: string[];     // 原始行，字节原样（不含行尾符）
}

export interface ListBlock {
  kind: 'list';
  id: string;
  roots: OutlineNode[];
}

// ---------- 节点 ----------
export interface OutlineNode {
  id: string;                  // session 内稳定 id（nanoid），不落盘；host 在 init/refresh 分配下发
  text: string;                // 节点正文（不含 bullet/marker、checkbox、行尾 blockId）
  checked: boolean | null;     // null = 普通节点（- text）；false = `- [ ]`；true = `- [x]`
  ordered?: OrderedMarker;     // 存在 = 有序列表项（`1.` / `1)`）；不存在/undefined = 普通 bullet（`-`）
  note: string | null;         // 节点备注，多行以 '\n' 连接；null = 无备注
  blockId: string | null;      // Obsidian block id（行尾 ^abc123 剥离后存这里），见 06
  mirror: string | null;       // 非 null 时本节点是镜像行，值为目标 blockId，见 06
  children: OutlineNode[];
  raw: RawSource | null;       // 未被编辑时的原始行缓存，保证字节级保真；一经编辑置 null
}

// 有序列表标记。num 是行内字面数字（解析所得 / split 时 +1 / toggleOrdered 时按前驱推算），
// 刻意不做自动重排——保持最小 diff（红线 2），Obsidian 打开照常按首项自增渲染。
export interface OrderedMarker {
  delim: '.' | ')';
  num: number;
}

export interface RawSource {
  lines: string[];   // 该节点自身的原始行：列表项行 + note 续行（不含子节点的行）
  depth: number;     // 解析时所处深度（root = 0）
}
```

## 字段语义细则

### `text`
- 单行字符串，不含换行。
- 已剥离：缩进、bullet 标记（`-`/`*`/`+`）、checkbox（`[ ] `/`[x] `）、行尾 blockId（` ^abc123`）。
- 已知歧义（接受，不做转义）：用户输入以 `[ ] ` 或 `[x] ` 开头的文本，序列化再解析会变成 checkbox 节点。这是 markdown 固有歧义，v1 不引入转义语法。

### `checked`
- 三态。`null` 与 `false` 在 UI 上的区别：`null` 无 checkbox 概念，`false` 是未完成任务（来自 Obsidian task）。
- `toggleChecked` 语义（定稿）：`null → true`、`false → true`、`true → false`。即完成后再取消会变成 `- [ ]`（任务节点），不会回到裸节点。理由：不引入隐藏状态，行为确定，round-trip 干净；Obsidian 对 `- [ ]` 完全兼容。

### `note`
- 列表项下方、缩进大于等于该项内容列的非列表续行（见 03 判定规则）。
- 多行 note 内部换行用 `'\n'`，序列化时每行加上正确缩进。

### `raw`（字节保真通道）
- parser 填充；节点的 `text/checked/note/blockId` 任一被修改 → `raw = null`。
- 序列化规则：`raw !== null` 且当前序列化深度 `=== raw.depth` → 直接输出 `raw.lines`（字节原样，3 空格缩进、`*` bullet 等非规范写法原封不动）；否则按 `indentUnit` 从字段重新生成（此时 bullet 统一为 `-`）。
- 深度比较的妙处：节点被 indent/outdent/拖拽到不同深度时，`raw.depth` 自动失配 → 整棵被移动的子树自然走重生成，**无需显式失效传播**；而同深度的 moveUp/moveDown/同层拖拽保持 raw 有效 → diff 最小。

### `id`
- 仅存活于 session 内存，**永不写入文件**。
- host 侧解析后统一分配（nanoid），随 `init`/`refresh` 快照下发，两端共享同一 id 空间。
- webview 新建节点（split/粘贴）时自行生成 nanoid 放入 op，host 采纳，避免一次往返。
- 外部修改重解析后，通过 `treeMatch`（见 04）尽量复用旧 id，使折叠状态与光标存活。

## 快照类型（shared/protocol.ts 引用）

跨消息边界传输的是与模型同构的纯数据快照。唯一差别：**快照中 `raw` 一律置 `null`**（webview 不做序列化，不需要 raw；省传输体积）：

```ts
export type DocSnapshot = {
  blocks: Block[];          // 其中所有 OutlineNode.raw === null
  indentUnit: IndentUnit;
};

export type NodeSnapshot = OutlineNode;   // 结构相同，约定 raw 为 null
```

host 侧的 mirror tree（带 raw）才是序列化依据；webview 树只服务渲染与乐观更新。两端对同一 op 序列的**结构**演化必须一致（applyOp 共享保证），raw 的差异不影响结构语义。

## 代码块：可编辑的 RawBlock（路线 B，0.4.0）

围栏代码块在本模型里**始终是文档级 RawBlock**（parser 把每个围栏切成独立 RawBlock，见 03）——它是列表的兄弟、不是任何节点的孩子。这是「字节保真的纯 Markdown」的必然结果：Obsidian 里在列表中间写围栏也是同样效果。因此：

- **代码块只能在顶层，不能嵌套在某个节点下面。** 想要嵌套代码只能走「私有约定」，会破坏「卸载后原样可读」，故不做。
- **可编辑**：渲染层给代码块 RawBlock 一个 `<textarea>`，改动经 `setRawBlock{id, lines}` 整块替换（保留首尾围栏行，只换正文）。`setRawBlock` 只对「首行是围栏」的 RawBlock 生效，其余 RawBlock 仍不可变（守住不变式 2 的边界）。
- **可创建**：在**空的顶层根节点**上打 ` ``` ` / ` ```lang ` 再回车，经 `toCodeBlock{id, lang, blockId, restId}` 把该节点所在 ListBlock 从该位置切开，中间插入代码块 RawBlock。非根节点上不触发（保持 ``` 为普通文本）。`blockId`/`restId` 由 webview 生成、host 采纳（同 split 的 newId），保证两端确定性一致。

数据模型的 `Block` / `RawBlock` / `OutlineNode` 类型**不变**——代码块复用现成的 RawBlock，没有新增节点种类（这正是选路线 B 而非路线 A 的原因）。

## 不变式（测试必须覆盖）

1. 任何时刻 `OutlineDoc` 中所有 `id` 全局唯一（跨 block）。
2. `RawBlock.lines` 与 `RawSource.lines` 永不被任何 op 修改（只会整体丢弃或原样输出）。**唯一例外：围栏代码块 RawBlock**——用户显式编辑时经 `setRawBlock` 替换其行，创建时经 `toCodeBlock` 生成（见下「代码块：可编辑的 RawBlock」）。frontmatter / 标题 / 正文段落 / 图片 / 空行等其余一切 RawBlock 仍严格不可变。红线 1（未被编辑内容字节级 round-trip）不受影响：只有被用户改动的代码块才重生成。
3. `mirror !== null` 的节点：`children` 恒为空数组、`note` 恒为 null（镜像行是纯引用行，见 06）。
4. 空文档（0 字节）解析为 `{ blocks: [], eofNewline: false }`；序列化回 0 字节。
5. 只含空行/正文的文档：一个或多个 RawBlock，无 ListBlock，round-trip 字节相等。
