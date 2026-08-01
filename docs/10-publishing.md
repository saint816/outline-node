# 10 — Marketplace 发布清单

按顺序执行；前 3 步在 M7 之前就应保持常绿（CI 里跑 `vsce package`）。

## 1. package.json 元数据

```json
{
  "name": "outline-node",
  "displayName": "OutlineNode — Workflowy-style Outliner",
  "description": "Workflowy-style outlining on plain local Markdown files. Obsidian/Logseq compatible.",
  "publisher": "outlinenode",
  "version": "1.0.0",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Notebooks", "Other"],
  "keywords": ["outliner", "workflowy", "outline", "markdown", "obsidian", "logseq", "notes"],
  "icon": "media/icon.png",
  "repository": { "type": "git", "url": "https://github.com/saint816/outline-node.git" },
  "license": "MIT",
  "galleryBanner": { "color": "#1e1e2e", "theme": "dark" }
}
```

## 2. 打包内容控制

`.vscodeignore` 只保留发布必需：`dist/`、`media/`、`README.md`、`CHANGELOG.md`、`LICENSE`。排除 `src/`、`test/`、`docs/`、`node_modules/`（esbuild 已 bundle，无运行时依赖进包）。`vsce package` 后检查 vsix 体积（目标 < 500KB）与 `vsce ls` 文件清单。

## 3. 实机验证

`code --install-extension outline-node-1.0.0.vsix` 在干净 profile 验证：安装即用、`*.outline.md` 默认打开、Reopen With、undo/保存/热恢复、卸载干净。

## 4. 账号与凭据

1. Azure DevOps 创建组织（Marketplace 发布的官方通道）。
2. 创建 PAT：scope 只勾 **Marketplace → Manage**，设置过期提醒。
3. [Marketplace 管理页](https://marketplace.visualstudio.com/manage) 创建 publisher（id 与 package.json 一致）。
4. 本地 `vsce login outlinenode`；CI 中 PAT 存 GitHub Secrets `VSCE_PAT`。
5. Open VSX（覆盖 VSCodium/Cursor 用户）：注册 open-vsx.org 账号 + 签 Publisher Agreement，token 存 `OVSX_PAT`。

## 5. README（Marketplace 门面）

- 首屏即 demo.gif（录制核心操作流：输入 → Tab 缩进 → 折叠 → zoom → 搜索）。
- 快捷键表（从 `docs/05` 的 keymap 表同步）。
- 与 Obsidian/Logseq 互通说明 + `workbench.editorAssociations` 配置示例。
- 数据安全一句话卖点：**纯本地纯 Markdown，无账号无云端，卸载后文件原样可读**。

## 6. 发布

- `1.0.0`：`vsce publish 1.0.0`；之后按 SemVer 递增。
- 自动化 `release.yml`：push tag `v*` → 全量测试 → `vsce publish -p $VSCE_PAT` → `ovsx publish -p $OVSX_PAT`。
- 版本策略：SemVer；CHANGELOG 每版必写（Keep a Changelog 格式）。

## 7. 发布后

- Marketplace 页面自查（图标、gif 渲染、分类、搜索"workflowy"能命中）。
- 干净机器（或 VS Code 全新 profile）从 Marketplace 安装验证。
- GitHub：开 Issues 模板（bug / feature）、Discussions；README 顶部加 Marketplace badge。
