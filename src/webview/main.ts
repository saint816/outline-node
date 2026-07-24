// webview bootstrap：acquireVsCodeApi、消息路由、事件接线、热恢复。
import './styles.css';
import { nanoid } from 'nanoid';
import { asH2W, type H2W, type W2H } from '../shared/protocol.js';
import { activeEditable, restoreCaret, saveCaret, type CaretPos } from './caret.js';
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
import { SidebarView } from './sidebar.js';
import { Toolbar } from './toolbar.js';
import { HelpOverlay } from './help.js';
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
}

const vscode = acquireVsCodeApi();
const root = document.getElementById('outline-root') as HTMLElement;

const send = (msg: W2H): void => vscode.postMessage(msg);
const store = new Store(send);
const renderer = new Renderer(root);

// zoom 前进/后退历史：所有「记录型」导航都走 navigate()，back/forward 只重放。
const zoomHistory = new ZoomHistory((id) => store.zoomTo(id));
function navigate(id: string | null): void {
  zoomHistory.go(id);
}

let sidebarCollapsed = false;

const breadcrumb = new Breadcrumb((id) => navigate(id));
const search = new SearchBox((query) => store.setSearchQuery(query));
const help = new HelpOverlay();
const sidebar = new SidebarView({
  onNavigate: (id) => navigate(id),
  onToggleStar: (id) => store.toggleStar(id),
  onToggleCollapse: () => {
    sidebarCollapsed = !sidebarCollapsed;
    saveViewState();
    render();
  },
  onMove: (id, parentId, index) => store.dispatch({ op: 'move', id, parentId, index }),
});
const toolbar = new Toolbar(
  {
    onBack: () => zoomHistory.back(),
    onForward: () => zoomHistory.forward(),
    onToggleHideCompleted: () => store.toggleHideCompleted(),
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

let nextCaret: CaretPos | null = null;
/** 下一帧渲染后把焦点放进这个代码块的 textarea（toCodeBlock 后用）。 */
let nextCodeFocus: string | null = null;
let ready = false;
const EMPTY_FOLDS: ReadonlySet<string> = new Set<string>();

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
      // 图片已落盘：重渲染让刚插入的 ![[name]] 预览能真正加载到文件
      render();
      return;
  }
});

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
  // 组合期间不发 setText（红线 4）
  if (ime.composing) return;
  if (target.dataset.field === 'code') {
    commitCodeBlock(target);
    return;
  }
  commitFieldText(target);
});

function commitFieldText(target: HTMLElement): void {
  const id = target.closest<HTMLElement>('.node')?.dataset.id;
  if (!id) return;
  if (target.dataset.field === 'note') store.setNodeNote(id, target.innerText);
  else store.setNodeText(id, target.textContent ?? '');
}

/** 代码块 textarea 改动 → 重建整块行（保留首尾围栏）→ setRawBlock。 */
function commitCodeBlock(target: HTMLElement): void {
  if (!(target instanceof HTMLTextAreaElement)) return;
  const block = target.closest<HTMLElement>('.raw-block');
  const blockId = block?.dataset.blockId;
  if (!block || !blockId) return;
  // textarea 随内容增高，避免加行时看不到
  target.style.height = 'auto';
  target.style.height = `${target.scrollHeight}px`;
  const open = block.dataset.codeOpen ?? '```';
  const body = target.value.split('\n');
  const lines =
    'codeClose' in block.dataset ? [open, ...body, block.dataset.codeClose as string] : [open, ...body];
  store.setRawBlockLines(blockId, lines);
}

// undo 三道闸之一：封死浏览器原生 undo 栈的一切入口（含右键菜单）
root.addEventListener('beforeinput', (event) => {
  const inputType = (event as InputEvent).inputType;
  if (inputType === 'historyUndo' || inputType === 'historyRedo') event.preventDefault();
});

root.addEventListener('keydown', (event) => {
  handleKeydown(event, {
    store,
    setNextCaret: (pos) => {
      nextCaret = pos;
    },
    requestUndo: () => send({ type: 'requestUndo' }),
    requestRedo: () => send({ type: 'requestRedo' }),
    newId: () => nanoid(),
    focusSearch: () => search.focus(),
    clearSearch: () => search.clear(),
    navigate: (id) => navigate(id),
    toggleHideCompleted: () => store.toggleHideCompleted(),
    focusCodeBlock: (blockId) => {
      nextCodeFocus = blockId;
    },
  });
});

// 帮助浮层：? 开关（焦点不在可编辑元素里时，避免吞掉输入的「?」），Esc 关闭。
// 挂在 document 上，这样焦点在侧栏/工具条时也能触发。
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && help.isOpen()) {
    help.close();
    return;
  }
  if (event.key === '?' && !isEditableTarget(event.target)) {
    event.preventDefault();
    help.toggle();
  }
});

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

// 点击交互（事件委托，不给每节点绑监听器，见 docs/07）
root.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
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
  setNextCaret: (pos) => {
    nextCaret = pos;
  },
  saveImage: (name, dataBase64) => send({ type: 'saveImage', name, dataBase64 }),
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
  };
  vscode.setState(state);
}

function restoreViewState(): void {
  const state = vscode.getState() as ViewState | undefined;
  if (!state) return;
  if (typeof state.hideCompleted === 'boolean') store.setHideCompleted(state.hideCompleted);
  if (typeof state.sidebarCollapsed === 'boolean') sidebarCollapsed = state.sidebarCollapsed;
  if (typeof state.zoomRootKey === 'string') {
    const id = store.idForKey(state.zoomRootKey);
    if (id) navigate(id);
  }
  if (typeof state.scrollTop === 'number') window.scrollTo({ top: state.scrollTop });
}

send({ type: 'ready' });
