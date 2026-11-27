# Xinyang Zeng's Homepage

一个已通过 GitHub Pages 发布的简洁个人主页，包含英文简历、Selected Publications、按年月归档的 Blog，以及仅供作者使用的 GitHub 授权写作工具。

> **当前状态（2026-11-27，任务 10 发布候选轮）**：公开站与作者端已真实上线并在用。本轮（分支 `r10-integration`，基线 `f90e5ec`）只做集成、回归、必要修复与文档更新；**本执行者没有 push、没有部署、没有改生产配置**（同期用户经 New! 发布了第 2 篇真实文章，那属于公开树变化）。
>
> | 线上事实 | 值 |
> |---|---|
> | 公开站 | <https://shironeshiyaro.github.io/>（`/`、`/publications/`、`/blog/`、`/settings/`、`/favicon.ico` 均 200；`/demo/` 线上 404，属 NOT RUN） |
> | 作者端 | <https://selfpage-author.2026310867.workers.dev/>（`/api/health` ok、`/api/session` 为 `anonymous`） |
> | 首次真实文章 | `/blog/2026/The first blog-2026-11-27-12-52-30/`（commit `1f0f015`） |
> | 第二篇真实文章 | `/blog/2026/The second blog-2026-11-27-15-33-22/`（commit `20588fa`；CI run #10 success、Pages run #12 success，2026-11-27 15:34 +08；`[台账/审查报告]`） |
> | 生产 GitHub App / 仓库 | App ID `5947211`；目标仓库 ID `1473941803`（旧 `1469597843` 已作废，**不要**再填入 allowlist） |
>
> `[台账]` 以上线上事实来自总控交接（`docs_AI/台账/总控/01-总控交接.md` §2）与独立发布审查报告（`03-发布审查.md` §1/§5），本执行者未重新部署。本文引用的 `docs_AI/**`、`docs/**` 与 `进度看板.html` 只存在于完整开发树；公开仓库/发布树不含它们，因此这些链接在公开树会 404。
>
> 本轮最终门禁（`8b724c5`，含第 6 篇内容 `6d790dc`；2026-11-27，Windows 11 / Node v26.13.1 / npm 11.20.0）。**测量时点 = commit `8b724c5`（真实内容 6 篇 / 11 页）**；原始日志（gitignored，仅本机）在 `test-results/r10/`，已提交摘要见 [assets](docs_AI/记录/r10/assets/)，完整矩阵见 [任务 10 执行记录](docs_AI/记录/r10/01-执行记录.md)：
>
> - `npm run check` exit 0：**38 条 workflow 结构不变量**、Worker 配置守卫、runner 输出路径守卫、**318** 个文本文件的格式检查（这是开发树；**公开树实测 289**，因为公开树不含 `docs/` 与 `docs_AI/`）、`astro check` 26 files / 0 errors；
> - `npm test` exit 0：**384 passed / 25 files**（新增 4 条同日排序用例）；
> - `npm run build` exit 0：真实内容 **11 pages**（6 篇文章）；作者端 Vite + `wrangler deploy --dry-run` 通过；
> - `npm run check:dist` exit 0：`BASE_PATH=/` 与 `/demo/` 各 **178 条内部链接 PASS**；Pages 产物无测试端点，作者端 client 保留 1 处仅测试端点调用、生产 Worker 返回 404（已有 E2E 断言）；
> - 生产预览（43221）：`/`、`/publications/`、`/blog/`、`/settings/`、`/favicon.ico` 五个 URL 全部 200；
> - 站点 E2E：**152 passed + 1 skipped**（root；跳过的是 sanitizer 攻击用例，需专用构建，见记录 §7）**+ 2 passed**（`/demo/`）；
> - 作者端 E2E：**80 passed / 4.8m**；作者端 GitHub 路由套件：**HTTP 32/32 + UI 8 passed**（fixture 内容，不受本次真实内容/排序修复影响）。
>
> **篇数会随用户发布继续增长，这些计数以交付 commit 实测为准；断言逻辑不随篇数变化。** 第 6 篇同步后：公开树 `origin/main` @ `20588fa` = 6 篇 / 11 页；开发树本分支 @ `8b724c5` 同步后同为 6 篇 / 11 页。
>
> 仍 **NOT RUN**（2026-11-27，节选；完整清单见记录 §7）：`/demo/` 的**线上**部署（本地两 base 已验证）、真实 iOS/Android 真机矩阵与移动读屏（`MOBILE_PENDING`）、桌面 Safari/Firefox、真实浏览器翻译与真实 Windows 高对比度、跨 colo 与“停 Worker 后线上可读”的线上实测、专用测试仓库的 Tier-2 发布（用户决定本轮不做）、作者端 `wrangler rollback` 演练、正式仓库分支保护 / `github-pages` environment 复核。
>
> 早期版本曾写"规划与调研阶段、尚未创建 `package.json`、`npm run dev` 不会成功"；该说明已过期，仅作历史记录。命令可用性以本页命令表为准。

## 项目目标

- **Home**：从一个 Markdown 简历生成页面和分栏导航。
- **Publications**：以学术列表展示精选论文，不产生侧栏二级项。
- **Blog**：按年份、月份归档；侧栏按年份和文章组织导航。
- **New!**：作者在同一后端 origin 的编辑器中写 Markdown，经 GitHub App 授权后创建内容 commit。
- **Settings**：Theme、Reduced Motion、Text Size。
- 无留言、评论、访客登录或账号系统；New! 是唯一授权例外。

## 重要架构说明

公开网页和作者编辑器是两个部署单元：

```text
https://<username>.github.io/       公开静态站，无登录，后端离线也可阅读
                  │ New!
                  ▼
https://<author-app>.workers.dev/   同源作者编辑器 + OAuth + 发布 API
                  │ GitHub App user access token
                  ▼
GitHub content commit → GitHub Actions → GitHub Pages
```

这样安排是因为 GitHub Pages 不能安全保存 client secret，而跨站会话 Cookie 又可能被浏览器阻止。GitHub token 只保存在服务端，公开站不会收到它。New! 地址统一通过 `PUBLIC_AUTHOR_ORIGIN` 配置，开发占位为 `https://selfpage-author.invalid`。

普通访客点击 New! 会先看到作者说明和 Back to Blog，不会被自动送入授权循环。

## 文档导航

### 先读这些

| 文档 | 用途 |
|---|---|
| [进度看板](进度看板.html) | 任务 01–10 当前状态、门禁结果、03–05 证据入口与下一步（浏览器直接打开） |
| [部署指南](docs/部署指南.md) | 三个部署单元、线上状态与生产标识、环境变量（公开/私密分类）、两种站点 base、GitHub App 生产/测试分离、Cloudflare 部署、CI 分工、产物自证、公开站 CSP 结论 |
| [运维、排障与回滚](docs/运维排障与回滚.md) | 线上状态与仍 NOT RUN 清单、commit≠部署、发布/Actions/token/分支保护/Worker 离线排障、`git revert` 回滚（origin/main worktree）、首次部署逐项确认清单（历史） |
| [个人主页调研文档](docs/个人主页调研文档.md) | 技术选型、GitHub App、安全、兼容性和参考来源 |
| [视觉与交互契约](docs/视觉与交互契约.md) | 顶栏、侧栏、层级导航、气泡、颜色、尺寸和页面行为 |
| [任务总览](docs_AI/任务总览.md) | 目标目录、模块边界、任务依赖和 ownership |
| [智能体工作规范](docs_AI/规范.md) | 台账、证据、测试和变更纪律 |
| [所有智能体的预装要求](docs_AI/要求.md) | 共同需求、现代指南分工、测试/审查规则 |
| [内容格式与校验契约](docs/内容格式.md) | Home/Publications/Blog 字段、route、CLI 与 fixtures |

### 智能体提示词

- 总控：[提示词_00-总控与编排.md](docs_AI/提示词_00-总控与编排.md)
- 执行任务：`docs_AI/提示词_01-*.md` 至 `提示词_10-*.md`
- 黑箱通用规则：[提示词_验收-00-通用规则.md](docs_AI/提示词_验收-00-通用规则.md)
- 每个大任务均有对应的 `docs_AI/提示词_验收-*.md`。

执行方必须另有独立测试和代码审查子智能体；纯黑箱验收者不得读取源码、diff、执行台账或其他角色的结论。

## 目录结构

任务 01–07.5 已建立下列全部目录与包：

```text
apps/
  site/          # Astro 公开站
  author/        # React 作者编辑器 + Cloudflare Worker BFF（含 GitHub OAuth/发布）
packages/
  content-model/ # 内容解析与导航 manifest
  markdown/      # New! Markdown 序列化、校验与预览
  design-tokens/ # 色彩、尺寸、排版与 motion tokens
  site-shell/    # 公开站/作者端共享的外壳 CSS、导航模型与 origin 校验（07.5）
content/
  home/
  publications/
  blog/YYYY/
tests/
docs/
docs_AI/
```

内容、代码、公开素材、设计参考和 AI 记录分开存放。详细 ownership 见 [任务总览](docs_AI/任务总览.md)。

## 第 0 步：准备仓库（首次或新环境）

当前线上环境已存在，本节只用于从零重建或迁移；日常改内容/代码请直接从下一节开始。

1. 取得代码：`git clone <repo> selfpage && cd selfpage`；或创建空仓库后 `git remote add origin <repo>`。
2. 确认默认分支是 `main`，并确认远端是**公开仓库**（用户站点仓库名 `<username>.github.io`）。
3. GitHub → **Settings → Pages → Build and deployment → Source = GitHub Actions**（不要选 "Deploy from a branch"）。
4. GitHub → **Settings → Secrets and variables → Actions → Variables**（是 **Variables，不是 Secrets**）建三个公开值：`SITE_URL`、`BASE_PATH`、`PUBLIC_AUTHOR_ORIGIN`。
5. 本仓库当前线上值（重建新环境时换成你自己的值，不要照抄到别的仓库）：

| 项 | 当前值 |
|---|---|
| 公开站 `SITE_URL` | `https://shironeshiyaro.github.io/` |
| `BASE_PATH` | `/`（项目站点用 `/<repo>/`） |
| `PUBLIC_AUTHOR_ORIGIN` | `https://selfpage-author.2026310867.workers.dev/`（建议带结尾 `/`；缺了会被规范化，但不要带 `/new/`） |
| 生产 App / 仓库 ID | App ID `5947211`；仓库 ID `1473941803` |

### 本仓库有两棵树（push 前必读）

- 本地 `main` = 完整开发历史（含 `docs_AI/`、`docs/`、进度看板）。
- `origin/main` = 从本地树裁出的公开树，**不含** `docs_AI/`、`docs/`、`进度看板.html`；两者**无共同祖先**（`git merge-base main origin/main` 无输出、exit 1）。
- 交付一处改动：先 `git fetch origin`，用 `git rev-parse origin/main` 确认与 GitHub main 一致，再建 worktree。PowerShell 示例（`<br>` 不能直接写，`<`/`>` 在 PowerShell 里是重定向符）：
  ```powershell
  $br = 'r10-docs'
  git fetch origin
  git rev-parse origin/main        # 应等于 GitHub main 的 commit
  git worktree add "F:\SelfPage-worktrees\_tmp\$br" -b $br origin/main
  # 在 worktree 里修改、验证、commit 后：
  git push origin "${br}:main"
  ```
  `git worktree add` 会按需创建缺失的父目录；路径必须在仓库外、又不能在 `F:\` 根目录。推送被 non-fast-forward 拒绝时不要 force，先 `git fetch origin` 再重试。
- 回滚：先 `git fetch origin`，在指向 `origin/main` 的 worktree 里 `git revert <live-sha>` → `git push origin HEAD:main`。本地没有该 live commit（未 fetch）时 revert 会失败。
- **内容同步（New! 只写公开树）**：New! 发布的文章 commit 进公开树，开发树 `content/` 不会自动得到。需要同步时：
  ```powershell
  git fetch origin
  git checkout origin/main -- content/blog
  ```
  或按单个文件 `git show origin/main:"content/blog/2026/<file>.md" > "content/blog/2026/<file>.md"`。**公开树的 `content/` 才是线上内容唯一来源，开发树不是镜像**；不要反过来把开发树的 `content/` 直接推上去，那会删掉线上文章。
- **绝不 `git push origin main`**（推错树/被拒）、**绝不 force-push**。详见[运维、排障与回滚](docs/运维排障与回滚.md) §3。

## 本地环境要求

本地开发需要：

1. **Node.js 24 LTS 或更新版本**：从 <https://nodejs.org/en/download> 安装，npm 随附。仓库 `engines` 为 `>=24`；本机实测 Node 26.13.1。安装后重开终端：
   ```bash
   node --version
   npm --version
   ```
2. **Git**：<https://git-scm.com/downloads>。
3. 本地开发不需要 Python；不需要全局安装 Astro、Wrangler 或 Playwright——全部通过 `npm ci` 装进本仓库。
4. **测试浏览器**：Playwright 配置使用系统已安装的 Microsoft Edge（Chromium 内核，`channel: 'msedge'`），不下载 Playwright 自带 Chromium。本机没有 Edge 时先装 Edge，或运行：
   ```bash
   npx playwright install msedge
   ```
   它优先使用系统 Edge（`[实测]` `install --dry-run msedge` 显示 `Install location: <system>`），缺了才下载。CI 也跑这一步，所以不假设运行环境一定有 Edge（见[部署指南](docs/部署指南.md) §7.4）。
5. 只有部署作者端时才需要 Cloudflare 账号和 `wrangler login`；只有真实授权发布验收时才需要独立测试 GitHub App 和专用测试仓库。两者都不影响本地阅读、构建和测试。

### 统一命令

| 命令 | 作用 | 状态 |
|---|---|---|
| `npm ci` | 按 lockfile 干净安装（`[09 实测]` 386 packages；本轮未重跑，npm ci 已完成） | 可用 |
| `npm run dev` | Astro 公开站开发服务器（默认 <http://localhost:4321/>）；本地要连作者端见下方“本地全栈 New!” | 可用 |
| `npm run dev:author` | 构建作者端静态文件并启动同源 Wrangler Worker（`GET /api/health`，`APP_ENV=test` 的 mock 授权） | 可用 |
| `npm run dev:author:github` | 作者端真实 GitHub 模式：构建后以 `--env-file ../../.dev.vars` 启动 Worker（生产模式，无 `APP_ENV`；只读本机 gitignored `.dev.vars`） | 可用（需已填 `.dev.vars`） |
| `npm run check` | `check:workflows`（CI/Pages 结构不变量 **38** 条）+ `check:worker`（生产 Worker 配置守卫）+ `check:runners`（runner 输出路径守卫）+ 各包 `tsc` + 公开站 `astro check` + 文本格式检查（本轮 **318** 文件） | 可用 |
| `npm run check:workflows` | 只跑 workflow 结构检查（权限、触发、`needs`、environment、Action 版本固定、无 secret、E2E 证据上传、手动部署仅 main） | 可用 |
| `npm run check:worker` | 只跑 `apps/author/wrangler.jsonc` 的生产守卫（不得出现 `APP_ENV`、必须有单作者 `AUTHOR_STORE` DO） | 可用 |
| `npm run check:runners` | 守卫 `tests/**` 下的 `.mjs`/`.js`/`.ts` 文件不得引用 `docs_AI/`（直接路径与数组/`join` 拼接都会红；两个自引用检查文件在 allowlist 里，`.md`/图片不在扫描范围；边界写在脚本注释里） | 可用 |
| `npm run check:dist` | **构建后**校验产物：内部链接 × BASE_PATH、无 sitemap、无本机绝对路径、无 secret/测试端点（本轮 root 与 `/demo/` 各 **178** 条链接） | 可用（需先 `npm run build`） |
| `npm run test` | Vitest 单元/集成测试（本轮 **384 passed / 25 files**） | 可用 |
| `npm run test:e2e` | 构建 root 与 `/demo/` 两套公开站，用系统 Edge 分别执行 Playwright（专用端口，不用外部服务）。**注意：用 `tests/fixtures/valid/site-content/content` 冻结快照，不测试你刚改的真实 `content/`，并会把 `apps/site/dist` 留在 fixture 内容上** | 可用（需本机 Edge） |
| `npm run test:e2e:author` | 作者端 06 套件 + 07.5/08 增补（mock GitHub，43243/43244，本轮 **80 passed / 4.8m**） | 可用 |
| `npm run test:e2e:author:github` | 07 套件：mock GitHub（43261）+ 真实路由 test Worker（43262）+ production-mode Worker（43263）；本轮 **HTTP 32/32 + UI 8 passed** | 可用 |
| `npm run test:e2e:author:h1` | E07 字面 H1 端到端证据脚本（临时内容根真实构建公开站） | 可用 |
| `npm run build` | 公开站静态构建 + 作者端 Vite/Worker 生产构建（真实内容本轮 **11 pages**） | 可用 |
| `npm run preview` | 公开站生产预览（**必须先 `npm run build`**，否则报 `The output directory … does not exist`）。自定义端口要写 `npm run preview --workspace @selfpage/site -- --port <n>`；根目录写成 `npm run preview -- --port <n>` 会被 npm 吞掉 `--port`，实测 exit 1 | 可用 |
| `npm run deploy:author` | **部署作者端到 Cloudflare**：origin 守卫（缺 `PUBLIC_SITE_ORIGIN`、非 https、loopback 直接中止）→ `check:worker` → 构建 → `wrangler deploy`（需先 `wrangler login`，见部署指南 §6） | 可用；`[台账]` 2026-11-27 已真实部署过，**再次部署需用户当次确认** |

`npm run check` 内的 `check:format` 只检查文本卫生（UTF-8、LF、尾随空白、末尾换行），且其 `docs_AI` 覆盖范围是 `tests/check-format.mjs` 的 `includeDocsAIPaths` 列表（规范/要求/任务总览、台账 01/02、记录 r01/r02）；`docs_AI/记录/r10/**` 与 `docs_AI/台账/10-*/**` **不在**扫描范围。仓库 `.gitattributes` 使用 `* text=auto eol=lf`，保证干净 checkout 的 LF 假设。ESLint/Prettier 等代码风格 lint **尚未引入**（09 只做了 workflow/部署/产物三类检查）；不要把格式检查当成完整 lint。

`npm run test:e2e` 使用专用端口 43211（root）和 43212（demo），端口被占用时立即失败，不会复用或停止外部进程；可用 `E2E_ROOT_PORT`/`E2E_DEMO_PORT` 覆盖。preview 的 PID 与日志记录在 `test-results/e2e-preview/preview-pids.txt` 和 `test-results/e2e-preview/e2e-preview-*.log`；该目录位于 Playwright 的 `outputDir` 之外，运行结束后仍保留。

**E2E 使用冻结内容快照**：`npm run test:e2e` 构建时把 `SELF_PAGE_CONTENT_ROOT` 指向 `tests/fixtures/valid/site-content/content`（4 篇占位文章），不测试你刚改的 `content/`，并把 `apps/site/dist` 留在 fixture 内容上（9 个页面）。验证自己的内容请按 `npm run content:validate -- content` → `npm run build` → `npm run preview`；跑完 E2E 后也要先重新 `npm run build` 再 preview。作者端 E2E 同样使用这份快照。

### 本地全栈 New!（公开站 + 作者端）

`npm run dev` 只起公开站。要让公开站的 New! 真正指向本机作者端，需要两个终端（都在仓库根）：

```powershell
# 终端 1：公开站构建/开发读 shell 环境变量
$env:PUBLIC_AUTHOR_ORIGIN='http://localhost:8787/'
npm run dev

# 终端 2：作者端（mock 授权，APP_ENV=test）
npm run dev:author
```

作用域（最容易踩）：

- 公开站构建读 **shell 环境变量** `PUBLIC_AUTHOR_ORIGIN`；不设时是占位 `https://selfpage-author.invalid/`，点 New! 是一次失败导航。
- 仓库根 `.dev.vars` 只给 **Wrangler 运行时**（`--env-file`）读取，不参与公开站构建，写进去不会让 New! 生效。
- 作者端构建读 shell 或 `apps/author/.env`、`.env.local`、`.env.production`、`.env.production.local`（后者覆盖前者，`process.env` 最终优先）。
- 这些都是构建期值；改完要重启 `npm run dev` 或重建作者端。

作者端 E2E 的日志与运行报告写在 **`test-results/author-e2e/`**（gitignored），不再写入 `docs_AI/记录/r06/assets/`——那是任务 06 的历史证据，2026-11-26 之前每次运行都会覆盖它（R09-6）。要留档时把该目录复制到 `docs_AI/记录/<round>/assets/`。

内容专用命令：

```bash
npm run content:validate -- content
npm run content:manifest -- content manifest.json
```

`BASE_PATH=/` 为默认；项目站点构建示例（PowerShell）：

```powershell
$env:BASE_PATH = '/demo/'
npm run build
```

测试/构建可用 `SELF_PAGE_CONTENT_ROOT` 切换内容根；它是测试 seam，不是部署配置。相对路径按进程 cwd 解析（`npm run build` 的子进程 cwd 是 `apps/site`），所以建议传绝对路径。`BASE_PATH` 缺尾斜杠会被规范化并输出 warning；`?`、`#`、`%`、`\`、`..` 等非法值仍会报错。

字段、NFC/NFD route 规则与 fixtures 见 [内容格式与校验契约](docs/内容格式.md)。

## GitHub 仓库选择

默认使用用户主页仓库：

```text
仓库名：<username>.github.io
地址：https://<username>.github.io/
```

也兼容普通项目仓库：

```text
仓库名：<repository>
地址：https://<username>.github.io/<repository>/
```

两种模式的 `SITE_URL` 和 `BASE_PATH` 会集中配置。当前**线上值**为 `SITE_URL=https://shironeshiyaro.github.io/`、`BASE_PATH=/`、`PUBLIC_AUTHOR_ORIGIN=https://selfpage-author.2026310867.workers.dev/`；项目站点可用 `/demo/` 本地构建验证（线上 `/demo/` 未部署）。新环境才使用占位值。两种模式的完整差异与 Pages Source 设置见[部署指南](docs/部署指南.md) §3。

## 部署（入口）

三个部署单元（详细步骤、变量分类、失败处理见[部署指南](docs/部署指南.md)）。**2026-11-27 现状：三个单元都已真实上线并在用**；下表把“已上线”与“仍 NOT RUN”分开。

| 单元 | 怎么部署 | 状态 |
|---|---|---|
| 公开站 → GitHub Pages | 在基于 `origin/main` 的 worktree 改完 → `git push origin <br>:main` 自动触发 `.github/workflows/pages.yml`；也可在 Actions 里手动 Run workflow（**必须选 main**） | `[台账]` **已上线（2026-11-27）**：<https://shironeshiyaro.github.io/> |
| 作者端 → Cloudflare Workers | **在仓库根**先设 `PUBLIC_SITE_ORIGIN`（https、非 localhost，否则守卫直接拒绝），再 `npx wrangler login` 和 `npm run deploy:author` | `[台账]` **已部署（2026-11-27）**：<https://selfpage-author.2026310867.workers.dev/>；再次部署需用户当次确认 |
| GitHub App（生产 / 测试分离） | github.com 网页操作，client secret 只进 `wrangler secret put` | `[台账]` 生产 App **已创建**（App ID `5947211`，只装正式仓库）；测试 App `5919244` 已完成使命、**不要**再装到正式仓库，删除时机由用户指导 |

**仍 NOT RUN（2026-11-27，节选；完整清单见 [任务 10 执行记录](docs_AI/记录/r10/01-执行记录.md) §7）**：`/demo/` 的线上部署（本地两 base 已验证，线上 404）、真实 iOS/Android 真机矩阵与移动读屏（`MOBILE_PENDING`）、桌面 Safari/Firefox、真实浏览器翻译与真实 Windows 高对比度、跨 colo 与“停 Worker 后线上可读”的线上实测、专用测试仓库的 Tier-2 发布、作者端 `wrangler rollback` 演练、正式仓库分支保护 / `github-pages` environment 复核。

硬规则：

- `.github/workflows/ci.yml` **只验证不部署**（权限只有 `contents: read`）；唯一的部署者是 `pages.yml`。CI 有两个并行 job：站点 E2E（`ci-site-e2e` artifact）与作者端 E2E（`ci-author-e2e` artifact），失败也都留证据。
- 两个 workflow 都**不读任何 repository secret**：公开站的 `SITE_URL`/`BASE_PATH`/`PUBLIC_AUTHOR_ORIGIN` 用仓库 **Variables**（公开值）。
- 真实的 `pages.yml` 手动运行（Run workflow）**必须选 main**：非 main ref 会在第一个 step 被拒绝，避免绕过 main 与分支保护。
- **交付必须走 `origin/main` worktree**：先 `git fetch origin`，再 `git worktree add F:\SelfPage-worktrees\_tmp\<br> -b <br> origin/main` → 改 → `git push origin <br>:main`。**绝不 `git push origin main`、绝不 force-push**（本地 `main` 与 `origin/main` 无共同祖先，见上文“两棵树”）。推送被 non-fast-forward 拒绝时先 `git fetch origin` 再重试，不要 force。
- 真实 push / 再次部署 / 配置 secret / 真实发布都要用户当次确认，清单见[运维、排障与回滚](docs/运维排障与回滚.md) §4。
- **commit 成功 ≠ 部署成功**：只看 `Deploy public site to GitHub Pages` 这个 workflow 的 run，不要用 CI 变绿推断站点已更新。

## 日常维护（作者本人）

> 面向会 Git、不熟悉网页托管的人。命令都在仓库根执行；`$br='...'` 里的名字自己换。更细的排障见[运维、排障与回滚](docs/运维排障与回滚.md) §6。

### 1. 写文章

只在**已部署的作者端 New!** 写：<https://selfpage-author.2026310867.workers.dev/new/>。流程是浏览器 → 作者端 → GitHub App 授权 → 一个 commit 进公开树 → `Deploy public site to GitHub Pages` 自动部署。上线与否用 **Actions**（看 `Deploy public site to GitHub Pages` 这个 workflow）或 **Deployments** 页确认；**不要用 CI 绿推断站点已更新**。开发树 `content/` 不会自动得到这篇，需要副本时按第 3 条同步。

### 2. 删文章

New! 只能新建、不能删。两种办法，删完侧栏/首页会同时消失、文章 URL 变 404、**没有重定向**，也没有“隐藏但不删”的功能。

**A. 网页最简（直接提交到 main）**

1. 打开 <https://github.com/ShironeShiyaro/ShironeShiyaro.github.io> → 进入 `content/blog/YYYY/`；
2. 点要删的 `<文件名>.md` → 右上 `...` → **Delete file** → **Commit changes**（提交到 main）；
3. 等 `Deploy public site to GitHub Pages` 绿，再用无痕窗口确认文章 URL 已 404。

**B. 本地可回滚**

```powershell
$br = 'del-post'
git fetch origin
git worktree add "F:\SelfPage-worktrees\_tmp\$br" -b $br origin/main
cd "F:\SelfPage-worktrees\_tmp\$br"
git rm "content/blog/2026/<文件名>.md"
git commit -m "content: remove <文章名>"
git push origin "${br}:main"
# 回到原来的仓库目录后清理：
git worktree remove "F:\SelfPage-worktrees\_tmp\$br"
```

删完按第 3 条同步开发树；想恢复用 `git revert <删除 commit>`（同样先 fetch，在 `origin/main` worktree 里做）。

### 3. 本地“pull” / 同步线上内容

**不要**在本地 `main` 上 `git pull`：本地 `main` 与 `origin/main` 无共同祖先，会失败或合错树。

```powershell
git fetch origin
git checkout origin/main -- content/blog   # 用线上内容覆盖本地 content/blog（会覆盖未提交改动！）
git show origin/main:"content/blog/2026/<文件名>.md"   # 只看单篇，不覆盖工作区
```

要一份“线上树”来检查或回滚：

```powershell
$br = 'live'
git fetch origin
git worktree add "F:\SelfPage-worktrees\_tmp\$br" -b $br origin/main
cd "F:\SelfPage-worktrees\_tmp\$br"
git fetch origin
git reset --hard origin/main
```

公开树的 `content/` 才是线上内容的唯一来源；开发树不是镜像，不要反向覆盖（会删掉线上文章）。

### 4. 看状态

- **Actions**：`CI` 只验证；`Deploy public site to GitHub Pages` 才是部署。
- **Deployments**：每次 Pages 部署记录（哪个 commit、成功/失败）。
- **Settings → Environments → github-pages**：部署历史与保护规则。
- **commit 成功 ≠ 部署成功**：只看部署 workflow 的 run 与线上页面。

### 5. 拒绝陌生人的 PR / 隐私设置

GitHub **没有**“关闭 Pull Request”的开关；别人永远可以 Fork 并开 PR。能做的设置是：

- **Settings → General → Features**：当前 Issues **开**、Wiki **开**、Projects **开**、Discussions 关。建议把 Issues/Wiki/Projects 关掉（Settings 里逐个取消勾选）。
- **Settings → Actions → General → Fork pull request workflows**：选 **Require approval for all outside collaborators**（外部 PR 的 CI 要你先批才跑）。
- **Settings → Access → Collaborators**：只保留自己。有人开 PR 就 Close（不合并永远不会生效）；必要时 Block。
- **安全事实**：`.github/workflows/ci.yml` 权限只有 `contents: read`，`pages.yml` 只在 main 上由 push/手动触发——**别人的 PR 永远不能发布或改你的站点**。
- **不建议把仓库改私有**：GitHub Pages 免费版对私有仓库不支持，站点会消失。

### 6. 页面地图

| 页面 | 能看 / 能改什么 |
|---|---|
| Code | 仓库文件；可网页编辑/删除内容并直接 commit |
| Actions | 两个 workflow 的 run、日志、artifact；可手动跑 pages.yml（必须 main） |
| Deployments | Pages 部署历史与对应 commit |
| Insights | 流量/贡献统计（不影响站点） |
| Settings → General → Features | Issues / Wiki / Projects / Discussions 开关 |
| Settings → Actions | workflow 权限、fork PR 审批 |
| Settings → Access → Collaborators | 协作者（只留自己） |
| Settings → Secrets and variables → Actions → **Variables** | `SITE_URL` / `BASE_PATH` / `PUBLIC_AUTHOR_ORIGIN` 三个公开值；**不要随便动**，改错会让站点/New! 链接失效 |
| 个人 Settings → Applications | 已安装的 GitHub App（应能看到 `selfpage-publish`）；不要乱装/乱卸 |

## 本地开发的两个陷阱

这两条是 08 期间真实踩到、并写进 09 文档的：

**陷阱 1：作者端构建期把 `PUBLIC_SITE_ORIGIN` 烘进 bundle，默认 `http://localhost:4321`。**

作者端是独立 origin，左侧导航和 "Back to Blog" 都靠构建期写入的公开站 origin。公开站不在 4321 跑（或线上地址不是 localhost）时，作者端这些链接会指向空气。

- 想让默认值生效：公开站就跑在 **4321**（`npm run dev` 默认）。
- 想换地址：显式覆盖**并重新构建作者端**：
  ```powershell
  $env:PUBLIC_SITE_ORIGIN='http://localhost:43321/'
  npm run build --workspace @selfpage/author
  ```
- 构建日志会打印 `author shell public site origin: ...`；未设置时会打印警告说明用了本地默认（`apps/author/vite.config.ts`）。**改环境变量后必须重建**，不重建等于没改。

**陷阱 2：跑门禁前必须先停掉 dev/preview，否则 `npm ci` 会 EPERM 并弄坏依赖树。**

Windows 上 dev/preview 进程占着 `node_modules` 里的文件（Astro 的 compiler binding），`npm ci` 需要清空 `node_modules`，会因文件被占用而 EPERM 失败，此时依赖树是半删半留的状态（后续命令会报找不到包）。

正确顺序：关掉所有 `npm run dev`/`dev:author`/`preview` 窗口 → 确认端口空出（`Get-NetTCPConnection -LocalPort 4321,8787,43243,43244 -ErrorAction SilentlyContinue`）→ 再 `npm ci` 或跑门禁。已经 EPERM 时：停掉所有 node 进程，重新 `npm ci`（必要时先删 `node_modules`）。

## 内容格式预览

New! 自动生成的可见 Markdown 为：

```md
# Example Post

2026-11-23

---

Body Markdown stays exactly as the author wrote it.
```

开头允许包含仅供构建器使用的 `title`、`date` YAML front matter。日期由后端按 `Asia/Shanghai` 生成，正文不添加额外 Markdown 语法。预装的简历、Publications 和 Blog 占位内容使用英文；真实文章语言不限（当前线上已有两篇中文正文文章），页面允许浏览器直接翻译。页面 H1 使用 content-model 的 title 作为转义后的纯文本渲染，不解释行内 Markdown：`~`、`<`、`*`、反引号与连续空格按字面保留，标题里的 `<script>` 不会执行。完整字段和校验规则见 [内容格式与校验契约](docs/内容格式.md)。

提交文件名采用安全化原始标题、完整日期和秒级时间：

```text
content/blog/2026/终于写好了这个页面-2026-11-23-23-42-15.md
```

H1 保留完整标题；文件名标题必须等于 H1 经 New! 安全化规则（NFC、替换跨平台非法字符）后的结果，不截断、不加 hash。标题限 60 个 Unicode code points，安全化标题限 232 UTF-8 字节，超限时拒绝发布并显示英文错误。New! 提交的文件名还必须避开 `# $ & + , : ; = ? @`（Blog route 单源限制），且 `-YYYY-MM-DD-HH-mm-ss` 中的日期/时间必须真实并与可见日期一致；手工编辑内容只改 H1/日期、不重命名文件时，文件名日期/标题不一致只输出 warning。

同一 draft ID 和内容在同一秒的重复提交视为误触，不创建第二个 commit。首次成功 commit 起 3 小时内，同一 draft ID + content hash 再次发布只返回原 commit；网络重试始终先对账，3 小时后只有再次显式点击 Publish 才允许同内容生成新文章。不同内容撞同一路径时不覆盖旧文件。

## 安全边界

- 生产 GitHub App 只安装到正式目标仓库，只申请 Contents Read/Write 和自动 Metadata Read；真实 E2E 使用独立测试 App 和专用测试仓库。两套 App 的 client id/secret、callback、数字 allowlist 完全隔离（[部署指南](docs/部署指南.md) §5）。
- client secret、GitHub token、session/token 密钥不得进入前端 bundle、URL、localStorage、日志或 Git 历史。真实值只经 `wrangler secret put`（Cloudflare）与用户本机的 gitignored `.dev.vars`；仓库根 `.dev.vars.example` 只有变量名与说明。
- 两个 GitHub Actions workflow 都不读 repository secret，因此没有 PAT/私钥进日志的路径；`.github/workflows/*` 的权限、触发与 Action 版本由 `npm run check:workflows` 机械校验。
- `apps/author/wrangler.jsonc` 不得出现 `APP_ENV`（那会打开 mock publish 与测试时钟）；`npm run check:worker` 与 `npm run deploy:author` 都会先拦这一条。
- OAuth state 与 PKCE S256 同时使用；session 使用同源 HttpOnly Cookie。OAuth transaction、session 与发布事务使用单作者固定 Durable Object，保证一次性 callback、立即登出和重试对账，不使用最终一致的 KV 承担这些保证。
- 真实写入测试只能使用专用测试仓库，不能用个人主仓库冒险。
- commit 成功不等于 Pages 已部署；界面和报告必须分别陈述。
- 公开站**没有** CSP：GitHub Pages 不能设响应头，而 `<meta>` CSP 不支持 `frame-ancestors`。`[实测 2026-11-27，真实内容 11 页]` 产物里有**四种**内联脚本（506B/4469B 每页 + Home 93B + Settings 586B），只给其中两个常量做 hash 会静默拦掉另外两个；脚本/构建变化后大小可能变，必须按[部署指南](docs/部署指南.md) §9.3 重新提取。做法、可执行的 hash 提取命令与拦截检查见[部署指南](docs/部署指南.md) §9。

## 给维护者

如果你只想改内容，未来主要编辑 `content/` 下的 Markdown；如果你要修改界面，先查 [任务总览](docs_AI/任务总览.md) 的模块 ownership。不要从旧记录推断某项功能“永远不需要”，范围决定都应有重议触发条件。

证据与记录约定：

- 每轮记录在 `docs_AI/记录/<round>/`，原始日志/截图在相邻 `assets/`；任务台账在 `docs_AI/台账/<任务>/`。
- `docs_AI/记录/r06/assets/` 是任务 06 的**历史证据**，任何测试运行都不应再写它（R09-6）。作者端 E2E 的输出在 `test-results/author-e2e/`（gitignored）。
- **所有 runner 的输出都在 `test-results/<suite>/`**（R09-6/R09-19：作者端、07 GitHub 套件、07.5 独立套件、导航验证脚本等），`docs_AI/记录/` 下不再有任何 runner 写入；`npm run check:runners` 会拦住回退。
- 改动部署相关文件后，至少跑：`npm run check`（含 workflow/worker 守卫）、`npm run build`、`npm run check:dist`、`npm run test:e2e`；涉及作者端/Worker 再跑 `npm run test:e2e:author`（本轮作者端 GitHub 路由套件为 `npm run test:e2e:author:github`）。
