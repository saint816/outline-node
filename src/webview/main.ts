// webview bootstrap：acquireVsCodeApi、消息路由、事件接线、热恢复。
import './styles.css';
import { nanoid } from 'nanoid';
import { asH2W, type H2W, type W2H } from '../shared/protocol.js';
import { activeEditable, restoreCaret, saveCaret, type CaretPos } from './caret.js';
import { ime, installImeGuard } from './ime.js';
import { handleKeydown } from './keymap.js';
import { installClipboard } from './clipboard.js';
import { installDragAndDrop } from './dnd.js';
import { Renderer } from './renderer.js';
import { SearchBox, applySearchFilter } from './search.js';
import { Store } from './store.js';
import { Breadcrumb } from './zoom.js';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

interface ViewState {
  /** 存 nodeKey 而非 id：id 不跨 session（见 docs/05 热恢复）。 */
  zoomRootKey: string | null;
  scrollTop: number;
}

const vscode = acquireVsCodeApi();
const root = document.getElementById('outline-root') as HTMLElement;

const send = (msg: W2H): void => vscode.postMessage(msg);
const store = new Store(send);
const renderer = new Renderer(root);
const breadcrumb = new Breadcrumb((id) => {
  store.zoomTo(id);
});
const search = new SearchBox((query) => store.setSearchQuery(query));
root.parentElement?.insertBefore(search.el, root);
root.parentElement?.insertBefore(breadcrumb.el, root);

let nextCaret: CaretPos | null = null;
let ready = false;
const EMPTY_FOLDS: ReadonlySet<string> = new Set<string>();

// ---------- 渲染 ----------

function render(): void {
  const caret = nextCaret ?? saveCaret();
  nextCaret = null;
  renderer.patch(
    { blocks: store.doc.blocks, indentUnit: store.doc.indentUnit },
    {
      // 搜索时把折叠视作展开，否则命中项藏在折叠子树里根本看不到
      folded: store.query === '' ? store.foldedIds : EMPTY_FOLDS,
      zoomRootId: store.zoomRoot,
    },
  );
  applySearchFilter(root, store.doc.blocks, store.query);
  breadcrumb.update(store.zoomTrail());
  syncPlaceholder();
  if (caret) restoreCaret(caret);
  saveViewState();
}

store.onChange(render);

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
  placeholder.textContent = '点击创建第一个节点';
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
  commitFieldText(target);
});

function commitFieldText(target: HTMLElement): void {
  const id = target.closest<HTMLElement>('.node')?.dataset.id;
  if (!id) return;
  if (target.dataset.field === 'note') store.setNodeNote(id, target.innerText);
  else store.setNodeText(id, target.textContent ?? '');
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
  });
});

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
    store.zoomTo(id);
  }
});

// 失焦 / 页面隐藏时立即 flush，缩小丢失窗口
root.addEventListener('focusout', () => store.flushPending(), true);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    store.flushPending();
    store.flushFolding();
  }
});

installDragAndDrop(root, store);
installClipboard(root, {
  store,
  setNextCaret: (pos) => {
    nextCaret = pos;
  },
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
  };
  vscode.setState(state);
}

function restoreViewState(): void {
  const state = vscode.getState() as ViewState | undefined;
  if (!state) return;
  if (typeof state.zoomRootKey === 'string') {
    const id = store.idForKey(state.zoomRootKey);
    if (id) store.zoomTo(id);
  }
  if (typeof state.scrollTop === 'number') window.scrollTo({ top: state.scrollTop });
}

send({ type: 'ready' });
