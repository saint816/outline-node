// webview 端轻量 i18n（真正的 i18n：跟随 VS Code 显示语言）。
// locale 由 host 注入到 <html lang="…">（buildHtml 用 vscode.env.language 填充），
// 这里在模块加载时同步读取——无需协议往返，SearchBox 等在 init 之前构造的组件也能拿到。
// 只维护两张目录：zh-cn 与 en；其余语言回退到 en。

type Locale = 'en' | 'zh-cn';

function resolveLocale(): Locale {
  const lang = (document.documentElement.lang || 'en').toLowerCase();
  return lang.startsWith('zh') ? 'zh-cn' : 'en';
}

const LOCALE: Locale = resolveLocale();

export type MessageKey =
  | 'search.placeholder'
  | 'search.ariaLabel'
  | 'placeholder.firstNode'
  | 'contextMenu.copyMirror'
  | 'toggle.expand'
  | 'toggle.collapse'
  | 'mirror.broken'
  | 'mirror.cycle'
  | 'mirror.ignoredChildren'
  | 'breadcrumb.ariaLabel'
  | 'breadcrumb.home'
  | 'node.empty'
  | 'sidebar.ariaLabel'
  | 'sidebar.starred'
  | 'sidebar.empty'
  | 'sidebar.collapsePanel'
  | 'sidebar.expandPanel'
  | 'sidebar.expandNode'
  | 'sidebar.collapseNode'
  | 'sidebar.star'
  | 'sidebar.unstar'
  | 'toolbar.back'
  | 'toolbar.forward'
  | 'toolbar.hideCompleted'
  | 'toolbar.showCompleted'
  | 'toolbar.help'
  | 'help.title'
  | 'help.close'
  | 'help.split'
  | 'help.note'
  | 'help.indent'
  | 'help.merge'
  | 'help.deleteNode'
  | 'help.move'
  | 'help.toggleChecked'
  | 'help.zoom'
  | 'help.fold'
  | 'help.moveCaret'
  | 'help.undo'
  | 'help.search'
  | 'help.hideCompleted'
  | 'help.help'
  | 'help.slash'
  | 'help.codeExit'
  | 'help.codeDelete'
  | 'help.codeEscape'
  | 'code.copy'
  | 'code.copied'
  | 'code.plain'
  | 'code.pickLang'
  | 'code.expand'
  | 'code.collapse'
  | 'help.codeIndent'
  | 'help.codeTitle'
  | 'format.ariaLabel'
  | 'format.bold'
  | 'format.highlight'
  | 'format.code'
  | 'format.link'
  | 'format.linkDialog'
  | 'format.linkTitle'
  | 'format.linkUrl'
  | 'format.saveLink'
  | 'format.cancel'
  | 'help.format'
  | 'help.multiSelect'
  | 'help.multiSelectClick'
  | 'slash.ariaLabel'
  | 'slash.noResults'
  | 'slash.codeBlock'
  | 'slash.codeTitleRequired'
  | 'deleteConfirm.title'
  | 'deleteConfirm.message'
  | 'deleteConfirm.cancel'
  | 'deleteConfirm.delete';

const EN: Record<MessageKey, string> = {
  'search.placeholder': 'Search nodes…',
  'search.ariaLabel': 'Search nodes',
  'placeholder.firstNode': 'Click to create the first node',
  'contextMenu.copyMirror': 'Copy as mirror link',
  'toggle.expand': 'Expand',
  'toggle.collapse': 'Collapse',
  'mirror.broken': 'Broken reference',
  'mirror.cycle': 'Circular reference',
  'mirror.ignoredChildren': 'Child lines under a mirror line are not rendered (data kept in the file).',
  'breadcrumb.ariaLabel': 'Zoom path',
  'breadcrumb.home': 'Home',
  'node.empty': '(empty node)',
  'sidebar.ariaLabel': 'Outline navigation',
  'sidebar.starred': 'Starred',
  'sidebar.empty': 'No nodes yet',
  'sidebar.collapsePanel': 'Collapse sidebar',
  'sidebar.expandPanel': 'Expand sidebar',
  'sidebar.expandNode': 'Expand',
  'sidebar.collapseNode': 'Collapse',
  'sidebar.star': 'Star',
  'sidebar.unstar': 'Unstar',
  'toolbar.back': 'Back',
  'toolbar.forward': 'Forward',
  'toolbar.hideCompleted': 'Hide completed',
  'toolbar.showCompleted': 'Show completed',
  'toolbar.help': 'Keyboard shortcuts',
  'help.title': 'Keyboard shortcuts',
  'help.close': 'Close',
  'help.split': 'Split node / new child',
  'help.note': 'Focus / create note',
  'help.indent': 'Indent / outdent',
  'help.merge': 'Merge with previous / unwrap an empty parent',
  'help.deleteNode': 'Delete the current node or selection',
  'help.move': 'Move node up / down',
  'help.toggleChecked': 'Toggle completed',
  'help.zoom': 'Zoom in / out',
  'help.fold': 'Fold / unfold',
  'help.moveCaret': 'Move caret between nodes',
  'help.undo': 'Undo / redo',
  'help.search': 'Focus search',
  'help.hideCompleted': 'Hide / show completed',
  'help.help': 'Toggle this help',
  'help.slash': 'Open the / insert menu',
  'help.codeExit': 'New node after code block',
  'help.codeDelete': 'Delete empty code block',
  'help.codeEscape': 'Leave code block (back to node text)',
  'code.copy': 'Copy',
  'code.copied': 'Copied',
  'code.plain': 'text',
  'code.pickLang': 'Change language',
  'code.expand': 'Expand code',
  'code.collapse': 'Collapse code',
  'help.codeIndent': 'Indent / outdent this node',
  'help.codeTitle': 'Insert a code block, then fill its required title',
  'format.ariaLabel': 'Text formatting',
  'format.bold': 'Bold',
  'format.highlight': 'Highlight',
  'format.code': 'Inline code',
  'format.link': 'Link',
  'format.linkDialog': 'Edit link',
  'format.linkTitle': 'Title',
  'format.linkUrl': 'URL',
  'format.saveLink': 'Save link',
  'format.cancel': 'Cancel',
  'help.format': 'Bold / highlight the selection',
  'help.multiSelect': 'Select multiple nodes (Tab / Alt+↑↓ / Cmd+Enter / Backspace apply to all)',
  'help.multiSelectClick': 'Extend the selection to the clicked node',
  'slash.ariaLabel': 'Insert menu',
  'slash.noResults': 'No matches',
  'slash.codeBlock': 'Code block',
  'slash.codeTitleRequired': 'Enter a node title before inserting a code block',
  'deleteConfirm.title': 'Delete subtree?',
  'deleteConfirm.message': 'Delete {roots} selected node(s) and {descendants} descendant(s)? This can be undone.',
  'deleteConfirm.cancel': 'Cancel',
  'deleteConfirm.delete': 'Delete',
};

const ZH: Record<MessageKey, string> = {
  'search.placeholder': '搜索节点…',
  'search.ariaLabel': '搜索节点',
  'placeholder.firstNode': '点击创建第一个节点',
  'contextMenu.copyMirror': '复制为镜像链接',
  'toggle.expand': '展开',
  'toggle.collapse': '折叠',
  'mirror.broken': '断链引用',
  'mirror.cycle': '循环引用',
  'mirror.ignoredChildren': '镜像行下的子行不参与渲染（数据保留在文件里）',
  'breadcrumb.ariaLabel': 'zoom 路径',
  'breadcrumb.home': '全部',
  'node.empty': '(空节点)',
  'sidebar.ariaLabel': '大纲导航',
  'sidebar.starred': '星标',
  'sidebar.empty': '还没有节点',
  'sidebar.collapsePanel': '收起侧栏',
  'sidebar.expandPanel': '展开侧栏',
  'sidebar.expandNode': '展开',
  'sidebar.collapseNode': '折叠',
  'sidebar.star': '加星标',
  'sidebar.unstar': '取消星标',
  'toolbar.back': '后退',
  'toolbar.forward': '前进',
  'toolbar.hideCompleted': '隐藏已完成',
  'toolbar.showCompleted': '显示已完成',
  'toolbar.help': '快捷键',
  'help.title': '快捷键',
  'help.close': '关闭',
  'help.split': '拆分节点 / 新建子节点',
  'help.note': '聚焦 / 创建备注',
  'help.indent': '缩进 / 反缩进',
  'help.merge': '与上一个节点合并 / 解包空父节点',
  'help.deleteNode': '删除当前节点或多选节点',
  'help.move': '上移 / 下移节点',
  'help.toggleChecked': '切换完成状态',
  'help.zoom': 'Zoom in / out',
  'help.fold': '折叠 / 展开',
  'help.moveCaret': '在节点间移动光标',
  'help.undo': '撤销 / 重做',
  'help.search': '聚焦搜索框',
  'help.hideCompleted': '隐藏 / 显示已完成',
  'help.help': '开关本帮助',
  'help.slash': '打开 / 插入菜单',
  'help.codeExit': '在代码块后新建节点',
  'help.codeDelete': '删除空代码块',
  'help.codeEscape': '退出代码块，回到节点正文',
  'code.copy': '复制',
  'code.copied': '已复制',
  'code.plain': '纯文本',
  'code.pickLang': '切换语言',
  'code.expand': '展开代码',
  'code.collapse': '收起代码',
  'help.codeIndent': '缩进 / 反缩进该节点',
  'help.codeTitle': '插入代码块后填写必填标题',
  'format.ariaLabel': '文字排版',
  'format.bold': '加粗',
  'format.highlight': '高亮',
  'format.code': '行内代码',
  'format.link': '链接',
  'format.linkDialog': '编辑链接',
  'format.linkTitle': '标题',
  'format.linkUrl': '链接',
  'format.saveLink': '保存链接',
  'format.cancel': '取消',
  'help.format': '加粗 / 高亮选中的文字',
  'help.multiSelect': '多选节点（Tab / Alt+↑↓ / Cmd+Enter / Backspace 批量生效）',
  'help.multiSelectClick': '把选区扩到点击的节点',
  'slash.ariaLabel': '插入菜单',
  'slash.noResults': '无匹配',
  'slash.codeBlock': '代码块',
  'slash.codeTitleRequired': '请先填写节点标题，再插入代码块',
  'deleteConfirm.title': '删除子树？',
  'deleteConfirm.message': '将删除 {roots} 个选中节点及 {descendants} 个后代，可通过撤销恢复。',
  'deleteConfirm.cancel': '取消',
  'deleteConfirm.delete': '删除',
};

export function t(key: MessageKey): string {
  const table = LOCALE === 'zh-cn' ? ZH : EN;
  return table[key] ?? EN[key] ?? key;
}
