// keydown → 语义 op（快捷键表见 docs/05）。
// 本模块只调 store.dispatch，不直接 postMessage、不改 DOM。
// M2 实现：Enter / Tab / Shift+Tab / Backspace 合并 / undo 转发；
// Alt+↑↓、Cmd+Enter、折叠、zoom、搜索留到 M3、M4。

import type { CaretPos } from './caret.js';
import { focusNode, saveCaret } from './caret.js';
import { isComposingEvent } from './ime.js';
import type { Store } from './store.js';

export interface KeymapContext {
  store: Store;
  /** patch 之后把光标放到这里。 */
  setNextCaret(pos: CaretPos): void;
  requestUndo(): void;
  requestRedo(): void;
  newId(): string;
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

  switch (e.key) {
    case 'Enter':
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
    default:
      return;
  }
}

function onEnter(caret: CaretPos, ctx: KeymapContext): void {
  const node = ctx.store.findNode(caret.nodeId);
  if (!node) return;

  // note 里回车 → 回到正文末尾（note 内换行是 Shift+Enter，M3 实现）
  if (caret.field === 'note') {
    focusNode(node.id, 'text', node.text.length);
    return;
  }

  // 展开且有子节点、光标在行尾 → 新建第一个子节点（Workflowy 语义）
  if (node.children.length > 0 && caret.offset >= node.text.length) {
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

function isCollapsed(): boolean {
  const selection = window.getSelection();
  return selection === null || selection.isCollapsed;
}
