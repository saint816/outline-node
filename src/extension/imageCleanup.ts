// 清理「粘贴进来但已经不被引用」的图片（孤儿资源）。两条入口：
//
// 1. **保存时自动清理**（默认开，设置 `outlineNode.cleanupUnusedImagesOnSave` 可关）：
//    只动**扩展自己生成**的 `pasted-*` 文件，移到废纸篓，状态栏一行提示。
// 2. **显式命令**（`outlineNode.cleanupImages`）：assets 目录里所有未被引用的图片，
//    带确认弹窗。
//
// 刻意**不挂在「删节点」上**：删节点是可 undo 的文本编辑，删文件不是——两者一耦合，
// undo 回来就是「正文在、图没了」，是 undo 修不好的损失。挂在保存上则给 undo 留出窗口
// （撤销后再保存，引用回来了就不算孤儿）。三道可逆保障：延到保存、限定 `pasted-*`、废纸篓。
// 作用范围始终限制在本文档自己的 `<文件名>/assets/` 目录内。

import * as vscode from 'vscode';

const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;
const WIKI_EMBED_RE = /!\[\[([^\]]+)\]\]/g;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;

/** 文档正文里引用到的图片文件名集合（只取最后一段：引用写法可能带目录）。 */
export function referencedImageNames(text: string): Set<string> {
  const names = new Set<string>();
  const add = (raw: string): void => {
    const path = raw.split('|')[0].trim(); // Obsidian 的 `![[img.png|200]]` 宽度后缀
    const name = path.split('/').pop();
    if (name) names.add(decodeURIComponent(name));
  };
  for (const m of text.matchAll(MD_IMAGE_RE)) add(m[1]);
  for (const m of text.matchAll(WIKI_EMBED_RE)) {
    if (m[1].startsWith('#')) continue; // 块引用 / 镜像
    add(m[1]);
  }
  return names;
}

/** 扩展粘贴生成的文件名（clipboard.ts：`pasted-<ts>-<rand>.<ext>`）。 */
const PASTED_NAME = /^pasted-\d+-[a-z0-9]+\.[a-z0-9]+$/i;

/** assets 目录里存在、但正文已不再引用的图片。`onlyPasted` = 只算扩展自己生成的文件。 */
export async function findOrphanImages(
  document: vscode.TextDocument,
  assetsDir: string,
  onlyPasted = false,
): Promise<vscode.Uri[]> {
  const dir = vscode.Uri.joinPath(document.uri, '..', ...assetsDir.split('/'));
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return []; // 目录不存在 = 没粘贴过图
  }
  const referenced = referencedImageNames(document.getText());
  return entries
    .filter(([name, type]) => type === vscode.FileType.File && IMAGE_EXT.test(name))
    .filter(([name]) => !onlyPasted || PASTED_NAME.test(name))
    .filter(([name]) => !referenced.has(name))
    .map(([name]) => vscode.Uri.joinPath(dir, name));
}

/** 保存时的自动清理：无弹窗、只动 `pasted-*`、移废纸篓、状态栏一行提示。 */
export async function autoPruneOrphanImages(
  document: vscode.TextDocument,
  assetsDir: string,
): Promise<number> {
  const orphans = await findOrphanImages(document, assetsDir, true);
  if (orphans.length === 0) return 0;
  let removed = 0;
  for (const uri of orphans) {
    try {
      await vscode.workspace.fs.delete(uri, { useTrash: true });
      removed++;
    } catch {
      // 单个失败不影响其余
    }
  }
  if (removed > 0) {
    // 静默删文件太吓人，但也不该弹窗打断：状态栏提示 4 秒
    vscode.window.setStatusBarMessage(
      vscode.l10n.t('OutlineNode: Moved {0} unused image(s) to the trash.', removed),
      4000,
    );
  }
  return removed;
}

/** 命令入口：找孤儿 → 确认 → 移到废纸篓。 */
export async function cleanupOrphanImages(
  document: vscode.TextDocument,
  assetsDir: string,
): Promise<number> {
  const orphans = await findOrphanImages(document, assetsDir);
  if (orphans.length === 0) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('OutlineNode: No unused images to clean up.'),
    );
    return 0;
  }

  const names = orphans.map((u) => u.path.split('/').pop()).join('\n');
  const confirm = vscode.l10n.t('Move to Trash');
  const answer = await vscode.window.showWarningMessage(
    vscode.l10n.t('OutlineNode: {0} unused image(s) in {1}. Move them to the trash?', orphans.length, assetsDir),
    { modal: true, detail: names },
    confirm,
  );
  if (answer !== confirm) return 0;

  let removed = 0;
  for (const uri of orphans) {
    try {
      await vscode.workspace.fs.delete(uri, { useTrash: true });
      removed++;
    } catch {
      // 单个失败不影响其余（可能被别的进程占用）
    }
  }
  void vscode.window.showInformationMessage(
    vscode.l10n.t('OutlineNode: Moved {0} unused image(s) to the trash.', removed),
  );
  return removed;
}
