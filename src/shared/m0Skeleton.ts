// 临时文件：M0 脚手架阶段的 host ↔ webview 消息（只读 <pre> 全文显示）。
// M2 实现 shared/protocol.ts（W2H / H2W 唯一契约，见 docs/04）时删除本文件。
// 之所以放在 shared/ 而不是各写一份：两端类型必须同源，避免绕过类型对齐（红线 9 的精神）。

export type M0Webview2Host = { type: 'ready' };

export type M0Host2Webview = { type: 'text'; text: string };
