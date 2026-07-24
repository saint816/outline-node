// keydown → 语义 op（快捷键表见 docs/05）。
// 本模块只调 store.dispatch / UI 状态变更，不直接 postMessage、不改树。

import {
  atFirstVisualLine,
  atLastVisualLine,
  caretRect,
  findEditable,
  focusNode,
  placeCaretAtLine,
  saveCaret,
  type CaretPos,
} from './caret.js';
import { isComposingEvent } from './ime.js';
import type { Store } from './store.js';

export interface KeymapContext {
  store: Store;
  /** patch 之后把光标放到这里。 */
  setNextCaret(pos: CaretPos): void;
  requestUndo(): void;
  requestRedo(): void;
  newId(): string;
  focusSearch(): void;
  clearSearch(): void;
  /** zoom 导航（走前进/后退历史），null = 回到全部。 */
  navigate(id: string | null): void;
  toggleHideCompleted(): void;
  /** 转成代码块后，把焦点放进该块 textarea（下一帧）。 */
  focusCodeBlock(blockId: string): void;
}

export function handleKeydown(e: KeyboardEvent, ctx: KeymapContext): void {
  // 组合期间把按键让给输入法，绝不执行结构操作（红线 4）。
  // SPEC-GAP: docs/05 说「直接 return」。但浏览器在组合期间仍会执行 Enter/Tab 的默认
  // 行为——实测（test/webview/ime.spec.ts）Enter 会往 contenteditable 里插入换行，把
  // 单行节点文本写成多行。这两个键必须 preventDefault：keyCode 229 的按键早已被输入法
  // 消费，拦掉默认行为不影响候选框，只是护住 DOM。
  if (isComposingEvent(e)) {
    if (e.key === 'Enter' || e.key === 'Tab') e.preventDefault();
    return;
  }

  const mod = e.metaKey || e.ctrlKey;

  // 插件内搜索（不用 VS Code 的 find widget，见 docs/05）
  if (mod && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    ctx.focusSearch();
    return;
  }
  if (e.key === 'Escape') {
    ctx.clearSearch();
    return;
  }

  // 隐藏 / 显示已完成（Workflowy ⌘O）
  if (mod && (e.key === 'o' || e.key === 'O')) {
    e.preventDefault();
    ctx.toggleHideCompleted();
    return;
  }

  // undo 三道闸之二：转发给 host 执行 VS Code 的 undo（红线 5）
  if (mod && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    ctx.store.flushPending();
    if (e.shiftKey) ctx.requestRedo();
    else ctx.requestUndo();
    return;
  }

  const caret = saveCaret();
  if (!caret) return;

  if (mod && e.key === '.') {
    e.preventDefault();
    ctx.store.toggleFold(caret.nodeId);
    ctx.setNextCaret(caret);
    return;
  }

  if (mod && e.key === 'Enter') {
    e.preventDefault();
    ctx.setNextCaret(caret);
    ctx.store.dispatch({ op: 'toggleChecked', id: caret.nodeId });
    return;
  }

  // 有序列表切换（Cmd/Ctrl+Shift+7，编辑器惯例：7 = 有序，8 = 无序）
  if (mod && e.shiftKey && e.code === 'Digit7') {
    e.preventDefault();
    ctx.setNextCaret(caret);
    ctx.store.dispatch({ op: 'toggleOrdered', id: caret.nodeId });
    return;
  }

  if (e.altKey) {
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown':
        e.preventDefault();
        ctx.setNextCaret(caret);
        ctx.store.dispatch({
          op: e.key === 'ArrowUp' ? 'moveUp' : 'moveDown',
          id: caret.nodeId,
        });
        return;
      case 'ArrowRight':
        e.preventDefault();
        ctx.navigate(caret.nodeId);
        ctx.setNextCaret(caret);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        zoomOut(ctx);
        return;
      default:
        break;
    }
  }

  switch (e.key) {
    case 'Enter':
      if (e.shiftKey) {
        // note 内的换行交给浏览器原生插入：plaintext-only 下它会自己处理尾部 <br>
        // filler，手工改写 innerText 反而会让光标落不到最后一行（实测）。
        // input 事件会把新的 innerText 同步成 setNote。
        if (caret.field === 'note') return;
        e.preventDefault();
        onShiftEnter(caret, ctx);
        return;
      }
      e.preventDefault();
      onEnter(caret, ctx);
      return;
    case 'Tab':
      e.preventDefault();
      onTab(caret, ctx, e.shiftKey);
      return;
    case 'Backspace':
      if (caret.field === 'text' && caret.offset === 0 && isCollapsed()) {
        e.preventDefault();
        onMerge(caret, ctx);
      }
      return;
    case 'ArrowUp':
    case 'ArrowDown':
      onVerticalMove(e, caret, ctx);
      return;
    default:
      return;
  }
}

function onEnter(caret: CaretPos, ctx: KeymapContext): void {
  const node = ctx.store.findNode(caret.nodeId);
  if (!node) return;

  // note 里回车 → 回到正文末尾
  if (caret.field === 'note') {
    focusNode(node.id, 'text', node.text.length);
    return;
  }

  // 顶层空壳节点上打 ``` / ```lang 回车 → 转成顶层代码块（见 02/04；代码块只能顶层）
  const fence = /^```(\w*)$/.exec(node.text);
  const loc = ctx.store.locationOf(node.id);
  if (
    fence &&
    loc?.parentId === null &&
    node.children.length === 0 &&
    node.note === null &&
    node.mirror === null
  ) {
    const blockId = ctx.newId();
    const restId = ctx.newId();
    ctx.focusCodeBlock(blockId);
    ctx.store.dispatch({ op: 'toCodeBlock', id: node.id, lang: fence[1], blockId, restId });
    return;
  }

  // 展开且有子节点、光标在行尾 → 新建第一个子节点（Workflowy 语义）
  const expanded = !ctx.store.isFolded(node.id);
  if (expanded && node.children.length > 0 && caret.offset >= node.text.length) {
    const id = ctx.newId();
    ctx.setNextCaret({ nodeId: id, field: 'text', offset: 0 });
    ctx.store.dispatch({
      op: 'insertSubtree',
      parentId: node.id,
      index: 0,
      nodes: [
        {
          id,
          text: '',
          checked: node.checked === null ? null : false,
          note: null,
          blockId: null,
          mirror: null,
          children: [],
          raw: null,
        },
      ],
    });
    return;
  }

  const newId = ctx.newId();
  ctx.setNextCaret({ nodeId: newId, field: 'text', offset: 0 });
  ctx.store.dispatch({ op: 'split', id: node.id, offset: caret.offset, newId });
}

/** Shift+Enter（在正文里）：note 为 null 时创建并聚焦，否则聚焦到 note 末尾。 */
function onShiftEnter(caret: CaretPos, ctx: KeymapContext): void {
  const node = ctx.store.findNode(caret.nodeId);
  if (!node) return;

  if (node.note === null) {
    ctx.setNextCaret({ nodeId: node.id, field: 'note', offset: 0 });
    ctx.store.dispatch({ op: 'setNote', id: node.id, note: '' });
    return;
  }
  focusNode(node.id, 'note', node.note.length);
}

function onTab(caret: CaretPos, ctx: KeymapContext, shift: boolean): void {
  // 缩进不改文本，光标偏移原样保持
  ctx.setNextCaret(caret);
  ctx.store.dispatch({ op: shift ? 'outdent' : 'indent', id: caret.nodeId });
}

function onMerge(caret: CaretPos, ctx: KeymapContext): void {
  const node = ctx.store.findNode(caret.nodeId);
  if (!node || node.children.length > 0) return;
  const previous = ctx.store.previousNode(caret.nodeId);
  if (!previous) return;

  // junction = 目标原 text 长度，dispatch 前记录（不进 op，见 docs/04）
  ctx.setNextCaret({ nodeId: previous.id, field: 'text', offset: previous.text.length });
  ctx.store.dispatch({ op: 'mergeWithPrevious', id: caret.nodeId });
}

/** ↑/↓：在首/末视觉行时跳到可见的前/后一个节点，横向列尽量保持。 */
function onVerticalMove(e: KeyboardEvent, caret: CaretPos, ctx: KeymapContext): void {
  const editable = findEditable(caret.nodeId, caret.field);
  if (!editable) return;
  const up = e.key === 'ArrowUp';
  if (up ? !atFirstVisualLine(editable) : !atLastVisualLine(editable)) return;

  const visible = ctx.store.visibleNodes();
  const at = visible.findIndex((n) => n.id === caret.nodeId);
  if (at === -1) return;
  const target = visible[up ? at - 1 : at + 1];
  if (!target) return;

  const targetEditable = findEditable(target.id, 'text');
  if (!targetEditable) return;

  e.preventDefault();
  const x = caretRect()?.left ?? targetEditable.getBoundingClientRect().left;
  placeCaretAtLine(targetEditable, x, up);
}

function zoomOut(ctx: KeymapContext): void {
  const trail = ctx.store.zoomTrail();
  const parent = trail.length >= 2 ? trail[trail.length - 2] : null;
  ctx.navigate(parent ? parent.id : null);
}

function isCollapsed(): boolean {
  const selection = window.getSelection();
  return selection === null || selection.isCollapsed;
}
