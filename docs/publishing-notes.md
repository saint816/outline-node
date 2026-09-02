# 发布实录与遗留问题（0.1.0）

> 本文不是规格。`10-publishing.md` 是计划，本文是**实际执行结果**——包括计划走不通的地方、绕过方式，以及发布后仍未收尾的事项。下次发版前先读这篇。
>
> 记录时间：2026-07-24（对应版本 0.1.0）

## 1. 发布结果

| 项 | 值 | 可改性 |
|---|---|---|
| 扩展 id | `outlinenode.outline-node` | **永久不可改** |
| Marketplace publisher | `outlinenode`（显示名 OutlineNode） | 不可改；unpublish 后名字仍被占用 |
| publisher 归属账号 | 微软个人账号（MSA） | — |
| GitHub | `https://github.com/saint816/outline-node`（public，main） | 可改，但改了要同步 `package.json.repository` |
| 首发版本 | 0.1.0，经 **publisher 管理页网页上传** | 同版本号不能覆盖 |
| vsix 体积 | 10 文件 / 37.77 KB（红线 500KB） | — |

发布时通过的验证：lint / typecheck / build 无告警，181 vitest + 60 playwright + 7 integration 全绿。

## 2. 与 `10-publishing.md` 的偏离（重要）

`10-publishing.md` 第 4 节写的账号链路是「Azure DevOps 建组织 → 签 PAT → `vsce login` / `vsce publish`」。**这条路在当前账号上走不通**，实测三处全堵：

1. **建组织被挡**：新建 Azure DevOps 组织强制关联 Azure 订阅——
   > To create an Azure DevOps organization, you need to link it to an Azure subscription. We couldn't find any subscriptions you have access to.

   而 Azure 免费账号注册必须绑定信用卡做身份验证。换干净的 signup 入口、以及 `az login` 建出 AAD 租户后重试，限制均不变。
2. **Entra ID 免 PAT 路径被挡**：`vsce publish --azure-credential` 内部向 Entra 申请 Azure DevOps 资源（`499b84ac-1321-427f-aa17-267ca6975798`）的 token。个人 MSA 从 /consumers 端点拿不到：
   > AADSTS9002332: Application 'Azure DevOps' is configured for use by Azure Active Directory users only. Please do not use the /consumers endpoint.
3. **AAD 租户 token 被 Marketplace 拒**：`az login --allow-no-subscriptions` 后能从「默认目录」租户拿到 token，但 `vsce verify-pat outlinenode --azure-credential` 返回：
   > InvalidAccessException: The requested operation is not allowed.

   publisher 归属的是 MSA 身份，不是该 AAD 租户里的身份。

**实际采用的方式**：publisher 管理页直接上传 `.vsix`，不需要 PAT，因而不需要 Azure DevOps 组织，也不需要绑卡。

```
marketplace.visualstudio.com/manage/publishers/outlinenode
  → New extension → Visual Studio Code → 选择 .vsix → Upload
```

上传后状态先是 `Verifying`，微软做安全扫描；**扫描完成前 gallery API 已能查到元数据，但 `code --install-extension` 会报 not found**，属正常时间差。0.1.0 实测约 15 分钟后可安装。

**点 Upload 会触发 reCAPTCHA 图片挑战**（"请选择包含 XX 的所有图块"）。挑战未通过时上传会静默失败——页面不报错，列表里也不出现新版本。这意味着网页上传路径**每次发版都需要人工过一次人机验证**，无法端到端自动化。要真正自动化只能回到 PAT 链路（见上文为何走不通）。

`release.yml` 已相应调整：`vsce publish` 那步加了 `if: env.VSCE_PAT != ''`，没配 secret 时跳过而非失败。哪天愿意绑卡拿到 PAT，加个 GitHub Secret 即可恢复自动化。

## 3. 遗留问题

| # | 问题 | 归属 |
|---|---|---|
| 1 | 干净环境下 M2/M3 验收项人工抽查（docs/08 中 M7 的第二条验收） | 人工，未做 |
| 2 | Open VSX 未发布，Cursor / VSCodium / Gitpod 用户搜不到 | 需人工注册 |
| 3 | 两个规格冲突未裁决（见 §5） | 待定 |
| 4 | 镜像在真实 Obsidian 中的渲染等价性未验证 | 人工，未做 |
| 5 | 中文 IME 真机手感、undo 粒度手感、与文本编辑器并排编辑体验 | 自动化测不出 |
| 6 | 「外部 refresh patch < 50ms」红线余量仅几毫秒 | 已缓解未根治 |
| 7 | `demo.gif` 由测试 harness 录制，无 VS Code 窗口边框 | 可选改进 |
| 7b | **插件 UI 只有中文**，但商店描述与 README 是英文 | 已知，暂不处理 |
| 8 | `10-publishing.md` 第 7 节「发布后」：README 加 Marketplace badge、开 Issues 模板与 Discussions | 未做 |

### UI 语言（第 7b 条的细节）

webview 与扩展宿主的用户可见文案全部是中文，会出现在商店首屏的 `demo.gif` 里：搜索框 placeholder `搜索节点…`、面包屑根 `全部`，另有 `点击创建第一个节点`、`复制为镜像链接`、`展开`/`折叠`、`断链引用`/`循环引用`、`OutlineNode: 没有活动的文本编辑器。` 等，散落在 `webview/search.ts`、`webview/zoom.ts`、`webview/nodeView.ts`、`webview/main.ts`、`extension/extension.ts`。

**2026-07-24 决定：暂不处理。** 若以后要做，两条路：

1. **全改英文**，不做 i18n。改动小，不碰协议，和商店页语言一致。
2. **真正的 i18n**（跟随 VS Code 语言）。webview 拿不到 locale，需要往 `EditorConfig` 加 `locale` 字段下发——这是**协议改动**（`04-protocol.md` / `shared/protocol.ts`），按项目约定必须先确认。

在此之前，英文 README 沿用中文内容的 `demo.gif`：UI 本来就是中文，换成英文内容反而会让人误以为界面是英文的。

### Open VSX 的前置条件（若要补）

- GitHub 登录 open-vsx.org，并注册 Eclipse Foundation 账号，**两边 GitHub 用户名必须一致**
- 必须签署 Open VSX Publisher Agreement，否则 publish 被拒
- 首发前需 `ovsx create-namespace outlinenode`，`release.yml` 中已就位，只差 `OVSX_PAT` secret
- namespace 可能因 typosquatting 检查被拒（与已有名字过于相似），被拒就换名——两个市场的 publisher id **允许不一致**
- 发布后若显示"非验证发布者"，去 `EclipseFdn/open-vsx.org` 提 issue 认领 namespace

## 4. 踩坑记录

### 4.1 发布链路

| 现象 | 原因 | 处理 |
|---|---|---|
| 建 Azure DevOps 组织时 Continue 点了没反应，DOM 上按钮也没 disabled | 前端静默拦截，真实原因是缺 Azure 订阅 | 放弃 PAT，改网页上传 |
| 账号下凭空多出一个 publisher | 首次访问 `/manage` 会按邮箱前缀**自动生成** publisher | 手动 Create 了 `outlinenode`，自动生成的那个弃用 |
| `vsce package` 报 `LICENSE not found` | `.vscodeignore` 改成白名单 `**` 后，`package.json` 被 vsce 强制包含但 **LICENSE 不会** | 显式 `!LICENSE` |
| 商店页首屏 gif 会裂 | README 相对图片链接由 `package.json.repository` 改写为绝对 URL，占位符没换 | 发布前必须填真实仓库地址并 `curl` 验证 raw URL 返回 200 |
| `release.yml` 里 `if: env.OVSX_PAT != ''` 恒为假 | **GitHub Actions 中 step 级 `env:` 在同一 step 的 `if:` 里不可见** | 提到 job 级 `env:` |
| 集成测试找不到扩展 | 包名 `outlinenode` → `outline-node` 后，`id.endsWith('.outlinenode')` 失配 | 同步断言 |

### 4.2 本机环境

| 现象 | 原因 | 处理 |
|---|---|---|
| `ssh -T git@github.com` 连到 `198.18.0.76` 后被关闭 | 代理拦截 SSH 22 端口；HTTPS 正常 | GitHub 一律走 HTTPS remote |
| `git push` 报 `Password authentication is not supported` | 未配 `credential.helper` | `gh auth setup-git` |
| 首次 push 被拒：`refusing to allow an OAuth App to create or update workflow ... without 'workflow' scope` | `gh auth login` 默认 scope 不含 `workflow`，仓库里有 `.github/workflows/` | `gh auth refresh -s workflow`（会再走一次设备码） |

### 4.3 自动化 / 测试

| 现象 | 原因 | 处理 |
|---|---|---|
| `.node[data-id=x] [data-field=text]` 报 strict mode violation | 后代选择器会匹配到**嵌套子节点**的同名字段 | 用 `> .node-row >` 直接子元素 |
| CDP 连已开浏览器时操作错了页面 | `pages().at(-1)` 不等于当前活动页，新标签页在数组中的位置不可靠 | 按 URL 匹配页面 |
| 性能基准偶发超时 | 与 57 个 webview 功能测试并行抢 CPU；单独跑立即通过 | 拆成独立 `perf` project，`workers: 1`、`fullyParallel: false`、`dependencies: ['chromium']`。**不要挪回主 project** |

### 4.4 更早阶段（M1–M6）

- `.gitattributes` **最后匹配的规则优先**，通用规则 `* text=auto eol=lf` 覆盖了 fixture 豁免，CRLF fixture 的 blob 被规整，新克隆过不了字节 round-trip。
- serializer 在非均匀缩进的文件上重排节点，会产出重新解析后深度不同的行——property test 抓到，靠 raw 行缩进区间校验 + 父级相对缩进生成修复。
- 组合（IME）期间的 Enter 会往 `contenteditable="plaintext-only"` 里插入换行，`05-webview.md` 写的"直接 return"不足以阻止，仍需 `preventDefault`。
- Playwright 跑了 stale `dist/`；ESLint 扫 315MB 的 `.vscode-test/` 把 Node OOM；a11y 焦点环测试因 harness 缺 `--vscode-*` 变量导致所有 `var()` 声明失效而失败。

**2026-09-02 更新**：插件 UI 已做双语（webview 跟随 VS Code 语言，`<html lang>` 驱动），`media/demo.gif` 已替换为**英文版演示**（英文 UI + 英文示例大纲，覆盖折叠/内联编辑/zoom/搜索）。录制脚本：`scripts/record-demo.mjs`（harness + Playwright recordVideo → ffmpeg 转 GIF，880×400 / 12fps）。README 图引用为 GitHub raw URL，push 后 Marketplace 页自动更新，无需重新上传 vsix。

## 5. 未决的规格冲突

两处 `docs/` 内部矛盾，M1 / M6 时提出，截至 0.1.0 发布仍未裁决，当前实现各自选了一边：

1. **混合行尾**：`02-data-model.md` 的 `OutlineDoc` 只有单个 `eol` 字段，而 `AGENTS.md` 红线 1 要求字节级 round-trip 幂等。文件内 CRLF/LF 混用时两者不可兼得。**当前按整文件统一 eol**，混合行尾的文件会被规整——严格说违反红线 1。改动点在 `core/serializer.ts`。
2. **镜像不变量 3**：`02-data-model.md` 规定镜像行不得带子行，`06-mirror.md` 要求解析器容忍这种文件。**当前按 `06` 容忍**：渲染层忽略镜像行下的子行、UI 打 ⚠ 标记，数据层原样保留不丢字节。改动点在 `core/parser.ts` 与 `webview/mirror.ts`。

裁决之前，别把这两处当 bug 去"修"。

## 6. 下次发版操作手册

```bash
# 1. 改版本号（同版本号不能覆盖！）
npm version patch --no-git-tag-version

# 2. 更新 CHANGELOG.md

# 3. 全量验证
npm run lint && npm run typecheck && npm test
npm run build && npx playwright test && npm run test:integration

# 4. 打包并核对
npm run package
npx vsce ls --no-dependencies          # 文件清单
unzip -p outline-node-*.vsix extension/readme.md | head -6   # 确认图片是绝对 URL

# 5. 隔离 profile 实机验证（不污染日常 VS Code）
code --user-data-dir /tmp/vsc-u --extensions-dir /tmp/vsc-e \
     --install-extension outline-node-*.vsix

# 6. 上传：marketplace.visualstudio.com/manage/publishers/outlinenode
#    → New extension → Visual Studio Code → 选 vsix → Upload
#    等 Verifying 结束后再验证 code --install-extension outlinenode.outline-node
```

有了 `VSCE_PAT` / `OVSX_PAT` 之后，第 4–6 步可由 `git tag vX.Y.Z && git push --tags` 触发 `release.yml` 自动完成。
