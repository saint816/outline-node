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
  | 'sidebar.outline'
  | 'sidebar.empty'
  | 'sidebar.collapsePanel'
  | 'sidebar.expandPanel'
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
  | 'help.move'
  | 'help.toggleChecked'
  | 'help.zoom'
  | 'help.fold'
  | 'help.moveCaret'
  | 'help.undo'
  | 'help.search'
  | 'help.hideCompleted'
  | 'help.help';

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
  'sidebar.outline': 'Outline',
  'sidebar.empty': 'No nodes yet',
  'sidebar.collapsePanel': 'Collapse sidebar',
  'sidebar.expandPanel': 'Expand sidebar',
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
  'help.merge': 'Merge with previous',
  'help.move': 'Move node up / down',
  'help.toggleChecked': 'Toggle completed',
  'help.zoom': 'Zoom in / out',
  'help.fold': 'Fold / unfold',
  'help.moveCaret': 'Move caret between nodes',
  'help.undo': 'Undo / redo',
  'help.search': 'Focus search',
  'help.hideCompleted': 'Hide / show completed',
  'help.help': 'Toggle this help',
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
  'sidebar.outline': '大纲',
  'sidebar.empty': '还没有节点',
  'sidebar.collapsePanel': '收起侧栏',
  'sidebar.expandPanel': '展开侧栏',
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
  'help.merge': '与上一个节点合并',
  'help.move': '上移 / 下移节点',
  'help.toggleChecked': '切换完成状态',
  'help.zoom': 'Zoom in / out',
  'help.fold': '折叠 / 展开',
  'help.moveCaret': '在节点间移动光标',
  'help.undo': '撤销 / 重做',
  'help.search': '聚焦搜索框',
  'help.hideCompleted': '隐藏 / 显示已完成',
  'help.help': '开关本帮助',
};

export function t(key: MessageKey): string {
  const table = LOCALE === 'zh-cn' ? ZH : EN;
  return table[key] ?? EN[key] ?? key;
}
