// webview bootstrap：acquireVsCodeApi、消息路由、事件接线、热恢复。
import './styles.css';
import { nanoid } from 'nanoid';
import { asH2W, type H2W, type W2H } from '../shared/protocol.js';
import {
  activeEditable,
  focusAtOffset,
  offsetFromPoint,
  restoreCaret,
  saveCaret,
  selectRange,
  selectionRange,
  type CaretPos,
} from './caret.js';
import { fenceLinesFrom, parseFence, renderFence, syncHighlight } from './codeFence.js';
import { LANGUAGES } from './highlight.js';
import { ime, installImeGuard } from './ime.js';
import { handleKeydown } from './keymap.js';
import { t } from './i18n.js';
import { installClipboard } from './clipboard.js';
import { installDragAndDrop } from './dnd.js';
import { expandMirrors, generateBlockId, mirrorLink, originalIdOf } from './mirror.js';
import { Renderer } from './renderer.js';
import { SearchBox, applyFilters } from './search.js';
import { Store } from './store.js';
import { Breadcrumb } from './zoom.js';
import { SidebarView, type SidebarNavSection } from './sidebar.js';
import { Toolbar } from './toolbar.js';
import { HelpOverlay } from './help.js';
import { closeLightbox, handleImageClick, isLightboxOpen, onLightboxClosed } from './lightbox.js';
import { hasInlineMarkup, isRendered, renderInline, sourceOffset, toSourceMode } from './inline.js';
import { toggleLink, toggleMarker, type Marker } from './format.js';
import { FormatBar } from './formatBar.js';
import { isMac } from './platform.js';
import { SlashMenu } from './slashMenu.js';
import { NodeSelection, handleSelectionKeydown } from './selection.js';
import { ZoomHistory } from './zoomHistory.js';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

interface ViewState {
  /** 存 nodeKey 而非 id：id 不跨 session（见 docs/05 热恢复）。 */
  zoomRootKey: string | null;
  scrollTop: number;
  hideCompleted: boolean;
  sidebarCollapsed: boolean;
  /** 被折叠的侧栏分区键（'starred' / 'outline'）。 */
  sidebarSections: string[];
}

const vscode = acquireVsCodeApi();
const root = document.getElementById('outline-root') as HTMLElement;

const send = (msg: W2H): void => vscode.postMessage(msg);
const store = new Store(send);
const renderer = new Renderer(root);
// 节点多选（Shift+↑↓ / Shift+点击）：纯 UI 状态，批量 op 复用既有 op（见 selection.ts）
const selection = new NodeSelection(store, root);

// zoom 前进/后退历史：所有「记录型」导航都走 navigate()，back/forward 只重放。
const zoomHistory = new ZoomHistory((id) => store.zoomTo(id));
let sidebarNavSection: SidebarNavSection = 'outline';
function navigate(id: string | null, section: SidebarNavSection = 'outline'): void {
  const sectionChanged = sidebarNavSection !== section;
  sidebarNavSection = section;
  zoomHistory.go(id);
  // 在 Starred / Home 的同一节点副本间切换时 zoom id 不变，store 不会 emit；
  // 仍需刷新侧栏，让 active 只跟随这次实际点击的入口。
  if (sectionChanged && store.zoomRoot === id) scheduleChrome();
}

let sidebarCollapsed = false;
let sidebarSections: string[] = [];

const breadcrumb = new Breadcrumb((id) => navigate(id));
const search = new SearchBox((query) => store.setSearchQuery(query));
const help = new HelpOverlay();
const sidebar = new SidebarView({
  onNavigate: (id, section) => navigate(id, section),
  onToggleStar: (id) => store.toggleStar(id),
  onToggleCollapse: () => {
    sidebarCollapsed = !sidebarCollapsed;
    saveViewState();
    render();
  },
  onMove: (id, parentId, index) => store.dispatch({ op: 'move', id, parentId, index }),
  onSectionsChanged: (keys) => {
    sidebarSections = [...keys];
    saveViewState();
  },
});
const toolbar = new Toolbar(
  {
    onBack: () => {
      sidebarNavSection = 'outline';
      zoomHistory.back();
    },
    onForward: () => {
      sidebarNavSection = 'outline';
      zoomHistory.forward();
    },
    onToggleHideCompleted: () => toggleHideCompletedWithFocus(),
    onHelp: () => help.toggle(),
  },
  search.el,
);

// 布局：.app( sidebar | .main-col( topbar, breadcrumb, #outline-root ) )。
// renderer 只操作 #outline-root 的子节点，把 root 挪进新父容器不影响渲染（见 docs/07）。
const app = document.createElement('div');
app.className = 'app';
const mainCol = document.createElement('div');
mainCol.className = 'main-col';
mainCol.append(toolbar.el, breadcrumb.el, root);
app.append(sidebar.el, mainCol);
document.body.append(app);

// 点图放大 → 关掉浮层：光标回到该节点正文末尾，接着按 Enter 就能建同级节点。
// 否则「点图 → Esc」之后焦点悬空，图片节点等于没有键盘出口（实机反馈）。
onLightboxClosed((nodeId) => focusNodeText(nodeId));

let nextCaret: CaretPos | null = null;
/** patch 之后把光标放到这里（结构 op 前记录，见 docs/04）。 */
function setNextCaret(pos: CaretPos): void {
  nextCaret = pos;
}
/** 下一帧渲染后把焦点放进这个代码块的 textarea（toCodeBlock 后用）。 */
let nextCodeFocus: string | null = null;
/** 同上，但目标是节点代码块（note 恰为围栏块）的 textarea，按节点 id 定位。 */
let nextNoteCodeFocus: string | null = null;
let ready = false;
const EMPTY_FOLDS: ReadonlySet<string> = new Set<string>();

// 斜杠插入菜单（/ → Code/To-do/编号）。keydown 前置拦导航键、input 后重算 token。
const slashMenu = new SlashMenu({
  store,
  newId: () => nanoid(),
  setNextCaret,
  focusCodeBlock: (blockId) => {
    nextCodeFocus = blockId;
  },
  focusNoteCode,
});

// ---------- 渲染 ----------

function render(): void {
  const caret = nextCaret ?? saveCaret();
  nextCaret = null;
  // 镜像展开是纯渲染层的事：数据层始终只有一份（见 docs/06）
  const blocks = expandMirrors(store.doc.blocks);
  const result = renderer.patch(
    { blocks, indentUnit: store.doc.indentUnit },
    {
      // 搜索时把折叠视作展开，否则命中项藏在折叠子树里根本看不到
      folded: store.query === '' ? store.foldedIds : EMPTY_FOLDS,
      zoomRootId: store.zoomRoot,
    },
  );
  applyFilters(root, blocks, store.query, store.hideCompleted);
  selection.syncHighlight(); // patch 重建过的节点重新打上 .selected（无选区时零成本）
  breadcrumb.update(store.zoomTrail());
  // 侧栏/工具条是「外壳」，不在大纲增量 patch 的关键路径上：挪到 macrotask 里合并更新，
  // 大文件外部 refresh 的 patch 时延只由 renderer.patch 决定（护住 50ms 红线，见 docs/07）。
  scheduleChrome();
  syncPlaceholder();
  if (caret) restoreCaret(caret);
  if (nextCodeFocus !== null) {
    const area = root.querySelector<HTMLTextAreaElement>(
      `.raw-block[data-block-id="${nextCodeFocus}"] textarea.code-input`,
    );
    nextCodeFocus = null;
    area?.focus();
  }
  if (nextNoteCodeFocus !== null) {
    // 直接查一次就放弃：不回填 nextNoteCodeFocus，免得目标一直不出现时每帧重试、误抢焦点
    noteCodeAreaOf(nextNoteCodeFocus)?.focus();
    nextNoteCodeFocus = null;
  }
  saveViewState();
  // 首帧分片：剩下的节点下一帧继续挂（见 docs/07）
  if (result.truncated) requestAnimationFrame(render);
}

store.onChange(render);

let chromePending = false;

/** 合并多次触发：一个 macrotask 内只更新一次侧栏 + 工具条。 */
function scheduleChrome(): void {
  if (chromePending) return;
  chromePending = true;
  setTimeout(() => {
    chromePending = false;
    updateChrome();
  }, 0);
}

function updateChrome(): void {
  const { nodes: starredNodes, ids: starredIds } = store.starred();
  sidebar.update({
    topLevel: store.topLevelNodes(),
    starred: starredNodes,
    currentZoomId: store.zoomRoot,
    currentSection: sidebarNavSection,
    isStarred: (id) => starredIds.has(id),
    collapsed: sidebarCollapsed,
  });
  toolbar.update({
    canBack: zoomHistory.canBack(),
    canForward: zoomHistory.canForward(),
    hideCompleted: store.hideCompleted,
  });
}

/** 空文档（还没有任何列表）时给一个可点击的落点，否则新文件是一片死白。 */
function syncPlaceholder(): void {
  const hasList = store.doc.blocks.some((block) => block.kind === 'list');
  let placeholder = document.getElementById('outline-placeholder');
  if (hasList || !ready) {
    placeholder?.remove();
    return;
  }
  if (placeholder) return;
  placeholder = document.createElement('div');
  placeholder.id = 'outline-placeholder';
  placeholder.className = 'placeholder';
  placeholder.textContent = t('placeholder.firstNode');
  placeholder.addEventListener('click', createFirstNode);
  root.append(placeholder);
}

function createFirstNode(): void {
  const id = nanoid();
  nextCaret = { nodeId: id, field: 'text', offset: 0 };
  store.dispatch({
    op: 'insertSubtree',
    parentId: null,
    index: 0,
    nodes: [{ id, text: '', checked: null, note: null, blockId: null, mirror: null, children: [], raw: null }],
  });
}

// ---------- host → webview ----------

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const msg = asH2W(event.data);
  if (!msg) return;

  switch (msg.type) {
    case 'init':
      ready = true;
      store.applyInit(msg);
      restoreViewState();
      return;
    case 'ack':
      store.applyAck(msg);
      return;
    case 'refresh':
      // 组合期间绝不触碰正在编辑节点的 DOM：搁置，commit 后再应用（红线 4）
      if (ime.composing) {
        ime.pendingRefresh = msg;
        return;
      }
      applyRefresh(msg);
      return;
    case 'imageSaved':
      // 图片已落盘。粘贴时预览 <img> 早于写盘就发过请求（404 且被缓存），syncImages 又因
      // src 未变而早退、不重建——必须显式给匹配 img 打 cache-bust 强制重新拉取（BUG-005）。
      render(); // 兜底：img 尚未建出来时先建（此时文件已存在，clean URL 直接加载得到）
      reloadSavedImage(msg.name);
      return;
  }
});

/** imageSaved 后强制重载该图的预览 <img>（绕开 404 缓存，见 imageSaved 分支）。 */
function reloadSavedImage(name: string): void {
  const encoded = encodeURIComponent(name);
  for (const img of root.querySelectorAll<HTMLImageElement>('img.node-image')) {
    const src = img.getAttribute('src') ?? '';
    if (src.includes(name) || src.includes(encoded)) {
      img.src = src.split('?')[0] + '?saved=' + Date.now();
    }
  }
}

function applyRefresh(msg: Extract<H2W, { type: 'refresh' }>): void {
  // refresh 会丢弃未 ack 的本地 op，把 contenteditable 里尚未提交的文本重新提交一次，
  // 用户感知几乎无损（见 docs/04）。
  // SPEC-GAP: docs/04 只对 cause:'conflict' 描述了重提交。external 同样需要——外部写入
  // 落地时用户可能正在打字（尤其 IME 提交那一刻），不补发就是丢字。唯独 undo 不补发：
  // undo 的本意就是把这个节点的文本改回去，补发等于立刻撤销这次 undo。
  const editable = activeEditable();
  const editingId = editable?.closest<HTMLElement>('.node')?.dataset.id ?? null;
  const editingField = editable?.dataset.field === 'note' ? 'note' : 'text';
  const domText = editable === null ? null : editingField === 'note' ? editable.innerText : editable.textContent;
  const caret = saveCaret();

  store.applyRefresh(msg);

  if (msg.cause !== 'undo' && editingId !== null && domText !== null) {
    const node = store.findNode(editingId);
    if (node && editingField === 'text' && node.text !== domText) {
      store.setNodeText(editingId, domText);
      nextCaret = caret;
      render();
    } else if (node && editingField === 'note' && (node.note ?? '') !== domText) {
      store.setNodeNote(editingId, domText);
      nextCaret = caret;
      render();
    }
  }
}

// ---------- 输入 ----------

root.addEventListener('input', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.dataset.field) return;
  selection.clear(); // 开始打字 = 退出多选（无选区时是空操作）
  // 组合期间不发 setText（红线 4）
  if (ime.composing) return;
  if (target.dataset.field === 'code') {
    commitCodeBlock(target);
    return;
  }
  if (target.dataset.field === 'noteCode') {
    commitNoteCode(target);
    return;
  }
  commitFieldText(target);
  slashMenu.sync(); // 文本已提交，重算 / token（sync 内部对非 text 字段自动关闭）
});

function commitFieldText(target: HTMLElement): void {
  const id = target.closest<HTMLElement>('.node')?.dataset.id;
  if (!id) return;
  if (target.dataset.field === 'note') store.setNodeNote(id, target.innerText);
  else {
    const text = target.textContent ?? '';
    store.setNodeText(id, text);
    // setNodeText 走不 emit 的热路径，侧栏不会自动刷新——只戳一下同名 label，O(1)。
    sidebar.syncText(originalIdOf(id), text);
  }
}

/** 代码块 textarea 改动 → 重建整块行（保留首尾围栏）→ setRawBlock。 */
function commitCodeBlock(target: HTMLElement): void {
  if (!(target instanceof HTMLTextAreaElement)) return;
  const block = target.closest<HTMLElement>('.raw-block');
  const blockId = block?.dataset.blockId;
  if (!block || !blockId) return;
  autoGrow(target);
  syncHighlight(block, target.value);
  store.setRawBlockLines(blockId, fenceLinesFrom(block, target.value));
}

/** 节点代码块（note 恰为围栏块）改动 → 重建整块行 → setNote（热路径，同 setNodeText）。 */
function commitNoteCode(target: HTMLElement): void {
  if (!(target instanceof HTMLTextAreaElement)) return;
  const block = target.closest<HTMLElement>('.node-code');
  const id = target.closest<HTMLElement>('.node')?.dataset.id;
  if (!block || !id) return;
  autoGrow(target);
  syncHighlight(block, target.value);
  store.setNodeNote(id, fenceLinesFrom(block, target.value).join('\n'));
}

/** textarea 随内容增高，避免加行时看不到。 */
function autoGrow(area: HTMLTextAreaElement): void {
  area.style.height = 'auto';
  area.style.height = `${area.scrollHeight}px`;
}

// undo 三道闸之一：封死浏览器原生 undo 栈的一切入口（含右键菜单）
root.addEventListener('beforeinput', (event) => {
  const inputType = (event as InputEvent).inputType;
  if (inputType === 'historyUndo' || inputType === 'historyRedo') event.preventDefault();
});

/** 代码块 textarea 内部自理的按键（不带修饰键时不交给 keymap）。 */
const CODE_LOCAL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Enter',
  'Backspace',
  'Delete',
  'Home',
  'End',
]);

root.addEventListener('keydown', (event) => {
  // 代码块 textarea 的出口手势（keymap 对 textarea 不生效，saveCaret 返回 null）
  const target = event.target;
  if (target instanceof HTMLTextAreaElement) {
    if (target.dataset.field === 'code' && handleCodeBlockKeydown(event, target)) return;
    if (target.dataset.field === 'noteCode' && handleNoteCodeKeydown(event, target)) return;
    // 没被出口手势消费的方向键/回车归 textarea 自己：keymap 的跨节点 ↑↓ 不认识
    // textarea 的行结构，会在代码块中间行就把光标弹到别的节点去。
    if (CODE_LOCAL_KEYS.has(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) return;
  }
  // 排版快捷键（加粗 / 高亮）：在 keymap 之前，免得被别的分支吃掉
  const marker = event.isComposing ? null : formatKeyOf(event);
  if (marker !== null) {
    event.preventDefault();
    applyFormat((text, start, end) => toggleMarker(text, start, end, marker));
    return;
  }
  // Esc 收起排版工具条（不阻断后续：Esc 还要退多选 / 清搜索）
  if (event.key === 'Escape') formatBar.hide();
  // 斜杠菜单激活时优先吃掉导航键（↑↓/Enter/Tab/Esc），keymap 不再处理
  if (event.key !== 'Process' && !event.isComposing && slashMenu.handleKeydown(event)) return;
  // 多选：Shift+↑↓ 进入/扩选；选中态下 Tab/Alt+↑↓/Cmd+Enter/Backspace 批量生效
  if (handleSelectionKeydown(event, { selection, setNextCaret })) return;
  handleKeydown(event, {
    store,
    setNextCaret,
    requestUndo: () => send({ type: 'requestUndo' }),
    requestRedo: () => send({ type: 'requestRedo' }),
    newId: () => nanoid(),
    focusSearch: () => search.focus(),
    clearSearch: () => search.clear(),
    navigate: (id) => navigate(id),
    focusCodeBlock: (blockId) => {
      nextCodeFocus = blockId;
    },
    focusNoteCode,
  });
});

/**
 * 代码块 textarea 的出口手势（代码块只能顶层、是文档级 RawBlock，容易变成死胡同）：
 * - Cmd/Ctrl+Enter：在代码块后新建一个顶层节点并聚焦（BUG-003）。
 * - 空代码块上 Backspace/Delete：删掉整个围栏代码块，焦点落到相邻节点（BUG-004）。
 * 返回 true = 已消费。
 */
function handleCodeBlockKeydown(e: KeyboardEvent, area: HTMLTextAreaElement): boolean {
  const blockEl = area.closest<HTMLElement>('.raw-block');
  const blockId = blockEl?.dataset.blockId;
  if (!blockEl || !blockId) return false;

  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    const id = nanoid();
    nextCaret = { nodeId: id, field: 'text', offset: 0 };
    store.dispatch({ op: 'insertRootAfterBlock', afterBlockId: blockId, id, blockId: nanoid() });
    return true;
  }

  // 顶层代码块是文档级块、没有层级可缩进，Tab 就按代码编辑器的直觉插两个空格
  // （默认行为是把焦点甩到别处，比什么都不做还糟）。
  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    const start = area.selectionStart;
    area.setRangeText('  ', start, area.selectionEnd, 'end');
    commitCodeBlock(area);
    return true;
  }

  // Esc：退到相邻节点正文（与节点代码块的出口手势一致）
  if (e.key === 'Escape') {
    const neighbor = adjacentNodeId(blockEl);
    if (neighbor === null) return false;
    e.preventDefault();
    focusNodeText(neighbor);
    return true;
  }

  if ((e.key === 'Backspace' || e.key === 'Delete') && area.value === '') {
    e.preventDefault();
    const neighbor = adjacentNodeId(blockEl);
    if (neighbor) nextCaret = { nodeId: neighbor, field: 'text', offset: 0 };
    store.dispatch({ op: 'deleteRawBlock', id: blockId });
    return true;
  }
  return false;
}

/**
 * 节点代码块（note 恰为围栏块）的出口手势，与顶层代码块对齐：
 * - Cmd/Ctrl+Enter：在该节点之后新建一个同级节点并聚焦；
 * - 空代码块上 Backspace/Delete：`setNote(null)` 去掉代码块，光标回到该节点正文末尾。
 */
function handleNoteCodeKeydown(e: KeyboardEvent, area: HTMLTextAreaElement): boolean {
  const id = area.closest<HTMLElement>('.node')?.dataset.id;
  if (id === undefined) return false;

  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    const location = store.locationOf(id);
    if (!location) return false;
    const newId = nanoid();
    setNextCaret({ nodeId: newId, field: 'text', offset: 0 });
    store.dispatch({
      op: 'insertSubtree',
      parentId: location.parentId,
      index: location.index + 1,
      nodes: [
        { id: newId, text: '', checked: null, note: null, blockId: null, mirror: null, children: [], raw: null },
      ],
    });
    return true;
  }

  if ((e.key === 'Backspace' || e.key === 'Delete') && area.value === '') {
    e.preventDefault();
    const node = store.findNode(id);
    setNextCaret({ nodeId: id, field: 'text', offset: node?.text.length ?? 0 });
    store.dispatch({ op: 'setNote', id, note: null });
    return true;
  }

  // Tab / Shift+Tab 缩进的是**这个节点**，不是代码文本。理由：代码块节点的正文宽度为 0、
  // 点不到，Tab 又是全 app 统一的层级手势；此前 Tab 只会把焦点甩走，等于没有缩进入口（实机反馈）。
  // 代码里要缩进就打空格。
  if (e.key === 'Tab') {
    e.preventDefault();
    store.dispatch({ op: e.shiftKey ? 'outdent' : 'indent', id });
    focusNoteCode(id);
    return true;
  }

  // 出口手势：Esc 回到本节点正文；末行 ↓ 去下一个可见节点；首行 ↑ 回本节点正文。
  // 没有这几条，代码块就是个只进不出的坑（实机反馈：编辑完跳不出来）。
  if (e.key === 'Escape') {
    e.preventDefault();
    leaveNoteCode(id, -1);
    return true;
  }
  if (e.key === 'ArrowUp' && atFirstLine(area)) {
    e.preventDefault();
    leaveNoteCode(id, -1);
    return true;
  }
  if (e.key === 'ArrowDown' && atLastLine(area)) {
    const next = nextVisibleNodeId(id);
    if (next === null) return false;
    e.preventDefault();
    focusNodeText(next, 0);
    return true;
  }
  return false;
}

/**
 * 退出节点代码块：正文有字就回正文；正文为空（= 这个节点就是一个代码块）则去相邻节点——
 * 空正文是零宽的，聚焦它只会在代码块旁边冒出一条空输入框，看着像 bug（实机反馈）。
 */
function leaveNoteCode(id: string, dir: -1 | 1): void {
  const node = store.findNode(id);
  if (node && node.text !== '') return focusNodeText(id);
  const rows = store.visibleRows();
  const index = rows.findIndex((row) => row.node.id === id);
  const neighbor =
    index < 0
      ? null
      : dir === -1
        ? (rows[index - 1]?.node.id ?? rows[index + 1]?.node.id ?? null)
        : (rows[index + 1]?.node.id ?? rows[index - 1]?.node.id ?? null);
  focusNodeText(neighbor ?? id);
}

/** textarea 光标是否在首行 / 末行（跨节点移动的判据，和正文的 ↑↓ 同一套直觉）。 */
function atFirstLine(area: HTMLTextAreaElement): boolean {
  return area.selectionStart === area.selectionEnd && !area.value.slice(0, area.selectionStart).includes('\n');
}

function atLastLine(area: HTMLTextAreaElement): boolean {
  return area.selectionStart === area.selectionEnd && !area.value.slice(area.selectionEnd).includes('\n');
}

/** 文档序里 id 之后的下一个可见节点。 */
function nextVisibleNodeId(id: string): string | null {
  const rows = store.visibleRows();
  const index = rows.findIndex((row) => row.node.id === id);
  return index >= 0 ? (rows[index + 1]?.node.id ?? null) : null;
}

/** 把光标放进某个节点的正文（默认末尾）；节点不在 DOM 里就留到下一帧。 */
function focusNodeText(nodeId: string, offset?: number): void {
  const node = store.findNode(nodeId);
  const pos: CaretPos = { nodeId, field: 'text', offset: offset ?? node?.text.length ?? 0 };
  const el = root.querySelector<HTMLElement>(
    `.node[data-id="${nodeId.replace(/["\\]/g, '\\$&')}"] > .node-row > [data-field="text"]`,
  );
  if (el) restoreCaret(pos);
  else setNextCaret(pos);
}

function noteCodeAreaOf(nodeId: string): HTMLTextAreaElement | null {
  // 代码块可能挂在行内（正文为空的代码块节点）或行下方（正文有字），两处都要找
  const id = nodeId.replace(/["\\]/g, '\\$&');
  return root.querySelector<HTMLTextAreaElement>(
    `.node[data-id="${id}"] > .node-code textarea.code-input,` +
      `.node[data-id="${id}"] > .node-row > .node-code textarea.code-input`,
  );
}

/** 聚焦该节点的代码块 textarea；元素还没建出来（刚发出 setNote）就留到下一帧。 */
function focusNoteCode(nodeId: string): void {
  const area = noteCodeAreaOf(nodeId);
  if (area) area.focus();
  else nextNoteCodeFocus = nodeId;
}

/** raw-block 相邻的 top-level 节点 id：优先前一个，否则后一个（删代码块后焦点落点）。 */
function adjacentNodeId(blockEl: HTMLElement): string | null {
  const pick = (dir: 'previousElementSibling' | 'nextElementSibling'): string | null => {
    let el: Element | null = blockEl[dir];
    while (el && !el.classList.contains('node')) el = el[dir];
    return el?.getAttribute('data-id') ?? null;
  };
  return pick('previousElementSibling') ?? pick('nextElementSibling');
}

/**
 * 隐藏 / 显示已完成的键位。webview 的按键会被转发给工作台做快捷键解析，所以只能挑
 * VS Code 没占用的组合——已被实机否掉两轮：
 *   `Cmd+O`      → VS Code「打开文件」
 *   `Cmd+Alt+O`  → Remote 扩展「Open Remote Window」
 * 现在按平台分：mac 用 `Ctrl+O`（mac 版 VS Code 未绑定）；Windows/Linux 上 `Ctrl+O`
 * 恰恰是「打开文件」，退回 `Ctrl+Alt+O`。用 `e.code` 而非 `e.key` 判定，免受 Option
 * 改字符 / 键盘布局影响。
 */
export function isHideCompletedKey(e: KeyboardEvent): boolean {
  if (e.code !== 'KeyO' || e.metaKey || e.shiftKey) return false;
  return isMac() ? e.ctrlKey && !e.altKey : e.ctrlKey && e.altKey;
}

// 帮助浮层：? 开关（焦点不在可编辑元素里时，避免吞掉输入的「?」），Esc 关闭。
// 隐藏已完成也挂在 document 上——隐藏后被隐藏节点的焦点会掉到 body，root 级监听收不到
// 第二次按键（BUG-002 焦点陷阱）。document 级则焦点在哪都能触发。
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isLightboxOpen()) {
    closeLightbox();
    return;
  }
  if (event.key === 'Escape' && help.isOpen()) {
    help.close();
    return;
  }
  if (isHideCompletedKey(event)) {
    event.preventDefault();
    toggleHideCompletedWithFocus();
    return;
  }
  if (event.key === '?' && !isEditableTarget(event.target)) {
    event.preventDefault();
    help.toggle();
  }
});

/** 切换隐藏已完成；若隐藏导致当前焦点节点消失，把焦点迁到最近的可见节点（BUG-002）。 */
function toggleHideCompletedWithFocus(): void {
  const active = document.activeElement;
  const activeNode = active instanceof HTMLElement ? active.closest<HTMLElement>('.node') : null;
  store.toggleHideCompleted(); // 同步 emit → render → applyFilters，返回后 .hidden 已生效
  if (activeNode && activeNode.offsetParent === null) {
    const visible = [...root.querySelectorAll<HTMLElement>('.node')].find(
      (n) => n.offsetParent !== null,
    );
    const field = visible?.querySelector<HTMLElement>('[data-field="text"]');
    if (field) field.focus();
    else search.focus(); // 全部隐藏时不把焦点留在 body
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

// 多选的鼠标入口挂在 document 上：Shift+点击另一个节点 → 选中区间；其余任何位置的
// 普通按下 → 退出多选（包括点侧栏 / 工具条，否则焦点走了高亮还留着）。
document.addEventListener('mousedown', (event) => {
  const target = event.target instanceof HTMLElement ? event.target : null;
  const id = target?.closest<HTMLElement>('.node')?.dataset.id;
  if (event.shiftKey && id !== undefined && root.contains(target)) {
    const anchor = selection.anchor ?? saveCaret()?.nodeId ?? null;
    // 同一节点内的 Shift+点击是「扩文本选区」，不抢；镜像视图不参与多选
    if (anchor !== null && anchor !== id && !anchor.includes('/') && !id.includes('/')) {
      event.preventDefault(); // 保住焦点，后续键盘批量操作仍能落到 root 的监听器
      selection.setRange(anchor, id);
      return;
    }
  }
  selection.clear();
});

// 点击交互（事件委托，不给每节点绑监听器，见 docs/07）
root.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (handleImageClick(target)) {
    event.preventDefault(); // 点图 = 放大预览，不落焦点、不 zoom
    return;
  }
  if (event.shiftKey) return; // Shift+点击归多选（上面的 mousedown），别顺手 zoom / 折叠
  const id = target.closest<HTMLElement>('.node')?.dataset.id;
  if (!id) return;
  if (target.closest('.toggle')) {
    event.preventDefault();
    store.toggleFold(id);
  } else if (target.closest('.bullet')) {
    event.preventDefault();
    navigate(id);
  }
});

// 长行横向滚动时，高亮层要跟着 textarea 走，否则两层错开。scroll 不冒泡，挂捕获阶段。
root.addEventListener(
  'scroll',
  (event) => {
    const area = event.target;
    if (!(area instanceof HTMLTextAreaElement) || !area.classList.contains('code-input')) return;
    const hl = area.closest<HTMLElement>('.raw-block')?.querySelector<HTMLElement>('.code-hl');
    if (hl) hl.scrollLeft = area.scrollLeft;
  },
  true,
);

// ---------- 行内排版（选区工具条 + 快捷键） ----------

const formatBar = new FormatBar({
  onMarker: (marker) => applyFormat((text, start, end) => toggleMarker(text, start, end, marker)),
  onLink: () => applyFormat((text, start, end) => toggleLink(text, start, end)),
});

/**
 * 对当前聚焦正文的选区施加排版。走 store.setNodeText（同打字的热路径：DOM 领先、
 * 不 emit），所以这里要自己把新文本写回 DOM 并重设选区。
 */
function applyFormat(
  transform: (text: string, start: number, end: number) => { text: string; start: number; end: number },
  requireSelection = false,
): boolean {
  const el = activeEditable();
  if (!el || el.dataset.field !== 'text') return false;
  const id = el.closest<HTMLElement>('.node')?.dataset.id;
  const range = selectionRange(el);
  if (!id || !range) return false;
  if (requireSelection && range.start === range.end) return false;

  const next = transform(el.textContent ?? '', range.start, range.end);
  el.textContent = next.text;
  store.setNodeText(originalIdOf(id), next.text);
  sidebar.syncText(originalIdOf(id), next.text);
  selectRange(el, next.start, next.end);
  syncFormatBar();
  return true;
}

/** 有选区就把工具条贴到选区上方，否则收起。 */
function syncFormatBar(): void {
  const el = activeEditable();
  if (!el || el.dataset.field !== 'text') return formatBar.hide();
  const range = selectionRange(el);
  if (!range || range.start === range.end) return formatBar.hide();
  const rect = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return formatBar.hide();
  formatBar.showAt(rect);
}

document.addEventListener('selectionchange', syncFormatBar);
window.addEventListener('scroll', () => formatBar.hide(), true);

/**
 * 排版快捷键。**只能挑 VS Code 没占的组合**：webview 的按键会转发给工作台做绑定解析，
 * preventDefault 拦不住（`Cmd+B` = 切换侧边栏）。故分平台，与隐藏已完成同一套路数：
 * mac 用 Ctrl+B / Ctrl+H，其余平台那两个被「侧边栏 / 全局替换」占着，改用 Ctrl+Alt+…。
 */
function formatKeyOf(e: KeyboardEvent): Marker | null {
  if (e.metaKey || e.shiftKey) return null;
  const combo = isMac() ? e.ctrlKey && !e.altKey : e.ctrlKey && e.altKey;
  if (!combo) return null;
  if (e.code === 'KeyB') return '**';
  if (e.code === 'KeyH') return '==';
  return null;
}

// 行内 Markdown 的显示态 / 源码态切换（见 inline.ts）。两件事都必须发生在浏览器
// 定位光标**之前**，所以挂 pointerdown 捕获阶段，不能等 focusin：
//   1) 点链接 → 交给 host 打开，不进编辑（按住 Alt/Cmd 则照常进去改字）；
//   2) 点正文 → 先还原源码态，让浏览器按源文本做命中测试，光标落点才对得上。
root.addEventListener(
  'pointerdown',
  (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const link = target.closest<HTMLElement>('.md-link');
    if (link && !event.altKey && !event.metaKey && !event.ctrlKey && event.button === 0) {
      event.preventDefault(); // 不聚焦、不移光标
      const url = link.dataset.url;
      if (url) send({ type: 'openLink', url });
      return;
    }
    const editable = target.closest<HTMLElement>('[data-field="text"]');
    if (!editable || !isRendered(editable)) return;
    // 换态会销毁被点的元素，浏览器自己的定位会断在半路 → 这里全程接管：
    // 先按落点算显示态偏移、换算回源码坐标，再换态、自己放光标。
    const src = editable.dataset.src ?? '';
    const rendered = offsetFromPoint(editable, event.clientX, event.clientY);
    toSourceMode(editable);
    event.preventDefault();
    focusAtOffset(editable, rendered === null ? src.length : sourceOffset(src, rendered));
  },
  true,
);

// 兜底：任何方式拿到焦点（程序化 focus()、Tab 键、辅助技术）都必须是源码态。
// pointerdown 那条只覆盖鼠标；漏了这条，用键盘走进来就会在「记号被隐藏」的文本上打字，
// 光标偏移与源文本对不上，setText 直接写错位置。
root.addEventListener(
  'focusin',
  (event) => {
    const el = event.target;
    if (el instanceof HTMLElement && el.dataset.field === 'text' && isRendered(el)) toSourceMode(el);
  },
  true,
);

// 失焦后回到显示态。渲染只在这里和 patch 里发生，打字过程中绝不重排 DOM。
root.addEventListener(
  'focusout',
  (event) => {
    const el = event.target;
    if (!(el instanceof HTMLElement) || el.dataset.field !== 'text') return;
    const id = el.closest<HTMLElement>('.node')?.dataset.id;
    if (!id) return;
    // 推到 macrotask：此刻焦点转移还没完成，立刻改 DOM 会打断它（同 scheduleChrome）
    setTimeout(() => {
      if (document.activeElement === el) return;
      const node = store.findNode(originalIdOf(id));
      if (!node || node.mirror !== null) return;
      if (hasInlineMarkup(node.text)) renderInline(el, node.text);
    }, 0);
  },
  true,
);

// 代码块的语言徽标即选择器：围栏行被渲染层摘掉了，不给入口就永远改不了语言（实机反馈）。
root.addEventListener('click', (event) => {
  const btn = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action="pick-lang"]');
  const block = btn?.closest<HTMLElement>('.raw-block');
  if (!btn || !block) return;
  event.preventDefault();
  const rect = btn.getBoundingClientRect();
  openLangMenu(rect.left, rect.bottom + 2, block);
});

// 代码块的复制按钮：委托到 root，读同一块里的 textarea 值，交给宿主写系统剪贴板。
// 刻意不用 navigator.clipboard / execCommand —— 它们在 VS Code webview 里静默失败过（见 docs/11）。
root.addEventListener('click', (event) => {
  const btn = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action="copy-code"]');
  if (!btn) return;
  const area = btn.closest<HTMLElement>('.raw-block, .node-code')?.querySelector('textarea.code-input');
  if (!(area instanceof HTMLTextAreaElement)) return;
  event.preventDefault();
  send({ type: 'copyText', text: area.value });
  btn.textContent = t('code.copied');
  btn.classList.add('done');
  window.setTimeout(() => {
    btn.textContent = t('code.copy');
    btn.classList.remove('done');
  }, 1200);
});

// 侧栏是纯导航面板，没有可编辑内容：吞掉右键，避免弹出 webview 的原生 Cut/Copy/Paste
// （那三项在侧栏里全是无效操作，实机反馈）。
sidebar.el.addEventListener('contextmenu', (event) => event.preventDefault());

// 右键菜单：复制为镜像链接（见 docs/06 创建入口）
root.addEventListener('contextmenu', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const nodeEl = target.closest<HTMLElement>('.node');
  if (!nodeEl?.dataset.id) return;
  event.preventDefault();
  openContextMenu(event.clientX, event.clientY, nodeEl.dataset.id);
});

function openContextMenu(x: number, y: number, nodeId: string): void {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'outline-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'context-menu-item';
  item.textContent = t('contextMenu.copyMirror');
  item.addEventListener('click', () => {
    copyAsMirrorLink(nodeId);
    closeContextMenu();
  });

  menu.append(item);
  document.body.append(menu);
  // 菜单内部的 pointerdown 不能关菜单，否则菜单项在收到 click 前就被摘掉了
  dismissContextMenu = (e: Event): void => {
    if (menu.contains(e.target as Node)) return;
    closeContextMenu();
  };
  document.addEventListener('pointerdown', dismissContextMenu);
}

/** 语言选择菜单：复用右键菜单的样式与关闭逻辑。 */
function openLangMenu(x: number, y: number, block: HTMLElement): void {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu lang-menu';
  menu.id = 'outline-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const current = block.querySelector('.code-lang')?.getAttribute('data-lang') ?? '';

  for (const lang of LANGUAGES) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'context-menu-item' + (lang.id === current ? ' current' : '');
    item.textContent = lang.label;
    item.addEventListener('click', () => {
      setFenceLang(block, lang.id);
      closeContextMenu();
    });
    menu.append(item);
  }
  document.body.append(menu);
  dismissContextMenu = (e: Event): void => {
    if (menu.contains(e.target as Node)) return;
    closeContextMenu();
  };
  document.addEventListener('pointerdown', dismissContextMenu);
}

/**
 * 改写围栏的开行语言，保留原缩进与围栏字符（``` / ~~~ 及其长度——字节保真红线）。
 * 改完走和「编辑代码」同一条提交路径，不新增 op。
 */
function setFenceLang(block: HTMLElement, lang: string): void {
  const open = block.dataset.codeOpen ?? '```';
  const m = /^([ \t]*)([`~]{3,})/.exec(open);
  block.dataset.codeOpen = `${m?.[1] ?? ''}${m?.[2] ?? '```'}${lang}`;
  const area = block.querySelector('textarea.code-input');
  if (!(area instanceof HTMLTextAreaElement)) return;

  // 本地先重建这一块：setNote / setRawBlock 是不 emit 的热路径（护击键红线），
  // 等不到重渲染；而换语言要加/删高亮层，只改文字不够。
  const isNodeCode = block.classList.contains('node-code');
  const fence = parseFence(fenceLinesFrom(block, area.value));
  if (fence) renderFence(block, fence, isNodeCode ? 'noteCode' : 'code');
  const next = block.querySelector<HTMLTextAreaElement>('textarea.code-input');
  if (!next) return;
  autoGrow(next);
  next.focus();
  if (isNodeCode) commitNoteCode(next);
  else commitCodeBlock(next);
}

let dismissContextMenu: ((e: Event) => void) | null = null;

function closeContextMenu(): void {
  if (dismissContextMenu) {
    document.removeEventListener('pointerdown', dismissContextMenu);
    dismissContextMenu = null;
  }
  document.getElementById('outline-context-menu')?.remove();
}

/** 必要时先 assignBlockId，再把 `![[#^id]]` 写进剪贴板。 */
function copyAsMirrorLink(rawId: string): void {
  const id = originalIdOf(rawId);
  const node = store.findNode(id);
  if (!node) return;

  let blockId = node.blockId;
  if (blockId === null) {
    blockId = generateBlockId(store.doc.blocks);
    store.dispatch({ op: 'assignBlockId', id, blockId });
  }
  void writeClipboard(mirrorLink(blockId));
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // webview 里 clipboard 权限可能被拒，退回 execCommand
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

// 失焦 / 页面隐藏时立即 flush，缩小丢失窗口
root.addEventListener('focusout', (event) => {
  store.flushPending();
  slashMenu.close(); // 焦点离开正文 → 关菜单（点菜单本身走 mousedown+preventDefault，不触发失焦）
  // 空 note 失焦 → 归一为 null：移除残留空行，并避免 serializer 把 note:'' 写成一行空白（红线 1）。
  // 用 macrotask 推迟到焦点转移完成后再动 DOM，不打断正在进行的 focus 切换（同 scheduleChrome 思路）。
  const el = event.target;
  if (el instanceof HTMLElement && el.dataset.field === 'note') {
    const id = el.closest<HTMLElement>('.node')?.dataset.id;
    // 用 DOM 实际内容判空（contenteditable 清空后 innerText 可能残留换行，别只比对存储值）
    const empty = el.innerText.trim() === '';
    setTimeout(() => {
      if (!id || !empty) return;
      const node = store.findNode(id);
      if (node && node.note !== null) {
        store.setNodeNote(id, null);
        render();
      }
    }, 0);
  }
}, true);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    store.flushPending();
    store.flushFolding();
    store.flushBookmarks();
  }
});

installDragAndDrop(root, store);
installClipboard(root, {
  store,
  selection,
  setNextCaret,
  saveImage: (name, dataBase64) => send({ type: 'saveImage', name, dataBase64 }),
  linkSelection: (url) => applyFormat((text, start, end) => toggleLink(text, start, end, url), true),
});

installImeGuard(root, {
  onCommit: (target) => commitFieldText(target),
  onFlushPendingRefresh: (msg) => {
    if (msg.type === 'refresh') applyRefresh(msg);
  },
});

// ---------- 热恢复 ----------

window.addEventListener('scroll', () => saveViewState(), { passive: true });

function saveViewState(): void {
  const zoomRoot = store.zoomRoot;
  const state: ViewState = {
    zoomRootKey: zoomRoot === null ? null : store.keyForId(zoomRoot),
    scrollTop: window.scrollY,
    hideCompleted: store.hideCompleted,
    sidebarCollapsed,
    sidebarSections,
  };
  vscode.setState(state);
}

function restoreViewState(): void {
  const state = vscode.getState() as ViewState | undefined;
  if (!state) return;
  if (typeof state.hideCompleted === 'boolean') store.setHideCompleted(state.hideCompleted);
  if (typeof state.sidebarCollapsed === 'boolean') sidebarCollapsed = state.sidebarCollapsed;
  if (Array.isArray(state.sidebarSections)) {
    sidebarSections = state.sidebarSections.filter((k): k is string => typeof k === 'string');
    sidebar.restoreSections(sidebarSections);
  }
  if (typeof state.zoomRootKey === 'string') {
    const id = store.idForKey(state.zoomRootKey);
    if (id) navigate(id);
  }
  if (typeof state.scrollTop === 'number') window.scrollTo({ top: state.scrollTop });
}

send({ type: 'ready' });
