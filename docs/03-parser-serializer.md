# 03 — Parser / Serializer 规格（src/core/parser.ts, serializer.ts, indent.ts）

## 为什么手写行级 parser，不用 remark/mdast

remark 不保证字节级序列化稳定（会规范化 bullet、缩进、空白），而本项目的红线恰恰是**未编辑内容字节原样**；且我们需要行号级控制与 `raw` 保真通道。我们只解析 markdown 的列表子集 + 块级识别，手写约 300 行，几千行文档解析 < 5ms。**禁止引入 remark/mdast/unified 依赖。**

## 接口

```ts
// parser.ts
export function parseOutline(text: string, opts: { defaultIndent: IndentUnit }): OutlineDoc;

// serializer.ts
export function serializeOutline(doc: OutlineDoc): string;

// indent.ts
export function detectIndent(lines: string[]): IndentUnit | null;  // null = 无列表可依据
```

## 解析：块级状态机

按行扫描（`text.split(/\r\n|\n/)`，同时统计 `\r\n` 占比确定 `doc.eol`，记录 `eofNewline`）。状态：

```
frontmatter → 仅当第 0 行恰为 '---'：收集至下一个恰为 '---' 的行（含），整体一个 RawBlock
fence       → 行匹配 /^\s*(```|~~~)/ 进入，收集至匹配同类 fence 的行（含），期间所有行进当前 RawBlock
default     → 逐行分类，见下
```

### default 状态下的行分类（按优先级）

1. **note 续行**：当前行紧跟在某列表项（或其 note）之后，且该行非空、有前导空白、`前导空白宽度 ≥ 该列表项的内容列`，且本身不匹配列表项正则 → 归为该列表项的 note 行。
   - 内容列 = 列表项行的 `缩进宽度 + bullet 长度 + 1`（即 `- ` 之后正文起始列）。
   - note 判定优先于 fence 判定：note 里写 ``` 会被当作 note 文本保留（不进入 fence 状态）。
2. **fence 开启行**：进入 fence 状态（连带终结当前 ListBlock）。
3. **列表项行**：正则 `/^([ \t]*)([-*+]) (.*)$/`。命中后进一步剥离：
   - checkbox：正文前缀匹配 `/^\[( |x|X)\] /` → `checked = false | true`，剥掉前缀；
   - blockId：正文行尾匹配 `/ \^([A-Za-z0-9-]+)$/` → 存 `blockId`，剥掉后缀；
   - mirror：剥完后正文**恰为** `![[#^<id>]]` → `mirror = id`（此时 text 保留原文字符串，渲染层特殊处理，见 06）。
4. **空行**：终结当前 ListBlock（若有），空行本身进 RawBlock。
5. **其他一切**（标题、正文、表格、引用块…）：进 RawBlock。标题 `#` **不映射为层级**——映射会让 Tab/outdent 语义与标题级别纠缠，round-trip 风险大而收益低（Workflowy 用户不用标题组织层级）。

连续的 RawBlock 行合并为一个 RawBlock；列表行序列构成 ListBlock。

### 列表树构建（ListBlock 内）

- 维护一个 (indentWidth, node) 栈。新列表项：
  - 缩进 > 栈顶 → 成为栈顶节点的子节点，入栈；
  - 缩进 == 某祖先层 → 弹栈至该层，成为其兄弟；
  - 缩进介于两层之间（如 3 空格夹在 2/4 之间）→ 归入不大于它的最近一层（宽容处理，raw 保真兜底原文）。
- tab 与空格混用：缩进宽度计算按 tab = 检测出的 space width（或 tab 单位文件里 tab 计 1 级）；异常混用同样宽容归层 + raw 兜底。
- 每个节点的 `raw = { lines: [列表项原始行, ...note 原始行], depth }`。
- 空行终结 ListBlock：loose list 会被拆成多个 ListBlock，中间空行是 RawBlock。这是已知取舍——模型简单、round-trip 稳；代价是跨"空行分隔的列表"不能 Tab/拖拽（不同 block）。渲染层可把「仅含空行的 RawBlock 且两侧都是 ListBlock」渲染得视觉上连续（纯样式，不改模型）。

## 缩进检测（indent.ts）

- 收集 ListBlock 构建过程中所有**相邻父子列表行**的缩进差，取众数。
- 任一列表行缩进含 `\t` → `{ kind: 'tab' }`（tab 优先）。
- 无列表或无父子对 → 返回 null，调用方回退到配置 `outlineNode.defaultIndent`（默认 2 空格——Workflowy/Obsidian 导出的公约数；Logseq 用户可配 tab）。
- 检测结果同时用于：note 续行列判定、新节点/重生成节点的序列化缩进。

## 序列化（serializer.ts）

逐 block 输出，行数组最后 `join(doc.eol)`，按 `eofNewline` 决定末尾换行：

- RawBlock → 直接输出 `lines`。
- ListBlock → 先序遍历，每个节点：
  - `raw !== null && raw.depth === 当前深度` → 输出 `raw.lines` 字节原样；
  - 否则重新生成：
    ```
    缩进 = indentUnit × 深度
    行   = 缩进 + "- " + (checked===true ? "[x] " : checked===false ? "[ ] " : "") + text + (blockId ? " ^"+blockId : "")
    note 每行 = 缩进 + indentUnit + noteLine     （note 缩进 = 正文深度 + 1 级）
    ```
  - 重生成时 bullet 统一为 `-`（仅编辑过的节点会被"规范化"，未编辑节点走 raw 原样——这是红线 2 的实现）。

## 无损往返：双保险

1. **raw 通道**：未编辑节点字节原样输出（见 02 的深度失配自动重生成机制）。
2. **幂等测试红线**（M1 验收，见 09）：
   - 对所有 fixture：`serializeOutline(parseOutline(s)) === s`（字节级严格相等）；
   - `parseOutline(serializeOutline(parseOutline(s)))` 与 `parseOutline(s)` 结构等价（忽略 id 与 raw）；
   - property test（fast-check）：随机生成树 → serialize → parse → 结构等价。

## 文件接管策略

见 `01-architecture.md` 的 contributes 片段：

- `*.outline.md` → viewType `outlineNode.outline`，`priority: "default"`（大纲文件的确定性入口；仍是纯 `.md`，Obsidian/GitHub 照常识别）。
- `*.md` → viewType `outlineNode.outlineOptional`，`priority: "option"`（通过 Reopen Editor With / `outlineNode.openAsOutline` 进入，不劫持正常 markdown 工作流）。
- 不发明新扩展名：与 Obsidian 互通硬性要求 `.md`。
- 目录级默认关联指导用户用 VS Code 原生 `workbench.editorAssociations`。

## 必备 fixture 清单（test/unit/fixtures/）

| fixture | 覆盖点 |
|---|---|
| `basic.md` | 纯 2 空格缩进列表，多层嵌套 |
| `obsidian-vault.md` | frontmatter + 标题 + 段落 + 列表混排 + `^blockId` |
| `logseq-tabs.md` | tab 缩进 + `- [ ]`/`- [x]` |
| `crlf.md` | CRLF 换行 + 末尾无换行 |
| `nonstandard.md` | 3 空格缩进、`*`/`+` bullet、层级跳跃（缩进直接 +2 级） |
| `notes.md` | 单行/多行 note、note 中含 ```、note 后接子列表 |
| `loose-list.md` | 空行分隔的列表（多 ListBlock） |
| `code-fence.md` | 代码块内含 `- ` 行（不得误判为列表） |
| `mirrors.md` | `^id` + `![[#^id]]` 镜像行 |
| `empty.md` / `blank-lines.md` | 空文件 / 只有空行 |
