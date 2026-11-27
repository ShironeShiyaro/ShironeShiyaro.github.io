# Xinyang Zeng's Homepage

一个计划通过 GitHub Pages 发布的简洁个人主页，包含英文简历、Selected Publications、按年月归档的 Blog，以及仅供作者使用的 GitHub 授权写作工具。

> **当前状态：任务 01–09 已完成。任务 09 只做"本地可验证"的部分，真实部署一律 NOT RUN。** 09 交付了 CI（`.github/workflows/ci.yml`）、Pages 部署（`.github/workflows/pages.yml`）、两种 base 的构建产物校验、作者端 Cloudflare 部署脚本与生产配置守卫、环境变量模板，以及[部署指南](docs/部署指南.md)与[运维、排障与回滚](docs/运维排障与回滚.md)。按总控裁定 R09-1，push、Pages 部署、Cloudflare 登录/部署、配置 secret、真实发布**都没有执行**，每一步要用户逐项确认（清单见运维文档 §4）。
>
> 09 本地门禁（2026-11-26，本分支 `r09-deploy`，基线 `ca981a0`）：`npm run check` 通过（含 **38 条 workflow 结构不变量**、生产 Worker 配置守卫、runner 输出路径守卫、**316** 个文本文件的格式检查）；`npm test` **380 passed / 25 files**；`npm run build` 通过（含作者端 `wrangler deploy --dry-run`）；`npm run check:dist` 在 `BASE_PATH=/` 与 `/demo/` 下各 **130 条内部链接 PASS**，产物无 secret / 测试端点 / sitemap / 本机绝对路径；站点 E2E **152 passed + 1 skipped**（root 基础）**+ 2 passed**（`/demo/` 基础）；作者端 E2E **80 passed**（补审轮按 P2-4 在每次运行前清空 `.wrangler/author-e2e-*` 后连跑 3 次，三次均 exit 0 / PASS，最后一轮 80 passed / 4.7m；早前的 79/1 未再现，见 `docs_AI/记录/r09/01-执行记录.md` §11）。两个 E2E 都已进入 CI，失败可从 run 页面下载 `ci-site-e2e` / `ci-author-e2e` artifact。
>
> 07.5 历史口径：独立测试 X01–X16 全 PASS、独立审查 P0=0、纯黑箱 ACCEPT（限定 Layer 1）；main 门禁（2026-11-26）`npm run check` 通过、351 单元/集成测试、站点 E2E 103 passed + 2 demo + 1 skipped、作者 E2E 69 passed。08 之后单元测试增至 380、作者 E2E 增至 80。
>
> 早期版本曾写"规划与调研阶段、尚未创建 `package.json`、`npm run dev` 不会成功"；该说明已过期，仅作历史记录。命令可用性以本页命令表和任务台账为准。

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
| [部署指南](docs/部署指南.md) | 三个部署单元、环境变量（公开/私密分类）、两种站点 base、GitHub App 生产/测试分离、Cloudflare 部署、CI 分工、产物自证、公开站 CSP 结论 |
| [运维、排障与回滚](docs/运维排障与回滚.md) | commit≠部署、发布/Actions/token/分支保护/Worker 离线排障、`git revert` 回滚、**真实部署逐项确认清单** |
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
| `npm ci` | 按 lockfile 干净安装（`[实测]` 386 packages） | 可用 |
| `npm run dev` | Astro 公开站开发服务器（默认 <http://localhost:4321/>） | 可用 |
| `npm run dev:author` | 构建作者端静态文件并启动同源 Wrangler Worker（`GET /api/health`，`APP_ENV=test` 的 mock 授权） | 可用 |
| `npm run dev:author:github` | 作者端真实 GitHub 模式：构建后以 `--env-file ../../.dev.vars` 启动 Worker（生产模式，无 `APP_ENV`；只读本机 gitignored `.dev.vars`） | 可用（需已填 `.dev.vars`） |
| `npm run check` | `check:workflows`（CI/Pages 结构不变量 **38** 条）+ `check:worker`（生产 Worker 配置守卫）+ `check:runners`（runner 输出路径守卫）+ 各包 `tsc` + 公开站 `astro check` + 文本格式检查 | 可用 |
| `npm run check:workflows` | 只跑 workflow 结构检查（权限、触发、`needs`、environment、Action 版本固定、无 secret、E2E 证据上传、手动部署仅 main） | 可用 |
| `npm run check:worker` | 只跑 `apps/author/wrangler.jsonc` 的生产守卫（不得出现 `APP_ENV`、必须有单作者 `AUTHOR_STORE` DO） | 可用 |
| `npm run check:runners` | 守卫 `tests/` 下任何文件都不得引用 `docs_AI/`（直接路径与数组/`join` 拼接都会红；覆盖边界写在脚本注释里） | 可用 |
| `npm run check:dist` | **构建后**校验产物：内部链接 × BASE_PATH、无 sitemap、无本机绝对路径、无 secret/测试端点 | 可用（需先 `npm run build`） |
| `npm run test` | Vitest 单元/集成测试（当前 **380**，25 个文件） | 可用 |
| `npm run test:e2e` | 构建 root 与 `/demo/` 两套公开站，用系统 Edge 分别执行 Playwright（专用端口，不用外部服务） | 可用（需本机 Edge） |
| `npm run test:e2e:author` | 作者端 06 套件 + 07.5/08 增补（mock GitHub，43243/43244，当前 **80** 条） | 可用 |
| `npm run test:e2e:author:github` | 07 套件：mock GitHub（43261）+ 真实路由 test Worker（43262）+ production-mode Worker（43263）；HTTP 32 条 + UI 8 条 | 可用 |
| `npm run test:e2e:author:h1` | E07 字面 H1 端到端证据脚本（临时内容根真实构建公开站） | 可用 |
| `npm run build` | 公开站静态构建 + 作者端 Vite/Worker 生产构建 | 可用 |
| `npm run preview` | 公开站生产预览（**必须先 `npm run build`**，否则报 `The output directory … does not exist`） | 可用 |
| `npm run deploy:author` | **部署作者端到 Cloudflare**：origin 守卫（缺 `PUBLIC_SITE_ORIGIN`、非 https、loopback 直接中止）→ `check:worker` → 构建 → `wrangler deploy`（需先 `wrangler login`，见部署指南 §6） | 未执行（NOT RUN，等用户确认） |

`npm run check` 内的 `check:format` 只检查文本卫生（UTF-8、LF、尾随空白、末尾换行）。仓库 `.gitattributes` 使用 `* text=auto eol=lf`，保证干净 checkout 的 LF 假设。ESLint/Prettier 等代码风格 lint **尚未引入**（09 只做了 workflow/部署/产物三类检查）；不要把格式检查当成完整 lint。

`npm run test:e2e` 使用专用端口 43211（root）和 43212（demo），端口被占用时立即失败，不会复用或停止外部进程；可用 `E2E_ROOT_PORT`/`E2E_DEMO_PORT` 覆盖。preview 的 PID 与日志记录在 `test-results/e2e-preview/preview-pids.txt` 和 `test-results/e2e-preview/e2e-preview-*.log`；该目录位于 Playwright 的 `outputDir` 之外，运行结束后仍保留。

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

两种模式的 `SITE_URL` 和 `BASE_PATH` 会集中配置。当前占位为 `SITE_URL=https://shironeshiyaro.github.io/`、`BASE_PATH=/`；项目站点可用 `/demo/` 构建验证。部署前仍需确认实际域名、默认分支与仓库设置。两种模式的完整差异与 Pages Source 设置见[部署指南](docs/部署指南.md) §3。

## 部署（入口）

三个部署单元（详细步骤、变量分类、失败处理见[部署指南](docs/部署指南.md)）：

| 单元 | 怎么部署 | 状态 |
|---|---|---|
| 公开站 → GitHub Pages | push 到 `main` 自动触发 `.github/workflows/pages.yml`；也可在 Actions 里手动 Run workflow | **NOT RUN**（未 push、未部署） |
| 作者端 → Cloudflare Workers | **在仓库根**先设 `PUBLIC_SITE_ORIGIN`（https、非 localhost，否则守卫直接拒绝），再 `npx wrangler login` 和 `npm run deploy:author` | **NOT RUN**（无登录、无上传） |
| GitHub App（生产 / 测试分离） | github.com 网页操作，client secret 只进 `wrangler secret put` | 生产 App **未创建**；测试 App 已存在 |

硬规则：

- `.github/workflows/ci.yml` **只验证不部署**（权限只有 `contents: read`）；唯一的部署者是 `pages.yml`。CI 有两个并行 job：站点 E2E（`ci-site-e2e` artifact）与作者端 E2E（`ci-author-e2e` artifact），失败也都留证据。
- 两个 workflow 都**不读任何 repository secret**：公开站的 `SITE_URL`/`BASE_PATH`/`PUBLIC_AUTHOR_ORIGIN` 用仓库 **Variables**（公开值）。
- 真实的 `pages.yml` 手动运行（Run workflow）**必须选 main**：非 main ref 会在第一个 step 被拒绝，避免绕过 main 与分支保护。
- 真实 push / 部署 / 配置 secret / 真实发布都要用户逐项确认，清单见[运维、排障与回滚](docs/运维排障与回滚.md) §4。
- **commit 成功 ≠ 部署成功**：只看 `Deploy public site to GitHub Pages` 这个 workflow 的 run，不要用 CI 变绿推断站点已更新。

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

开头允许包含仅供构建器使用的 `title`、`date` YAML front matter。日期由后端按 `Asia/Shanghai` 生成，正文不添加额外 Markdown 语法。预装简历、Publications 和 Blog 占位内容都会使用英文。页面 H1 使用 content-model 的 title 作为转义后的纯文本渲染，不解释行内 Markdown：`~`、`<`、`*`、反引号与连续空格按字面保留，标题里的 `<script>` 不会执行。完整字段和校验规则见 [内容格式与校验契约](docs/内容格式.md)。

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
- 公开站**没有** CSP：GitHub Pages 不能设响应头，而 `<meta>` CSP 不支持 `frame-ancestors`。产物里其实有**四种**内联脚本（506B/4469B 每页 + Home 93B + Settings 586B），只给其中两个常量做 hash 会静默拦掉另外两个。做法、可执行的 hash 提取命令与拦截检查见[部署指南](docs/部署指南.md) §9。

## 给维护者

如果你只想改内容，未来主要编辑 `content/` 下的 Markdown；如果你要修改界面，先查 [任务总览](docs_AI/任务总览.md) 的模块 ownership。不要从旧记录推断某项功能“永远不需要”，范围决定都应有重议触发条件。

证据与记录约定：

- 每轮记录在 `docs_AI/记录/<round>/`，原始日志/截图在相邻 `assets/`；任务台账在 `docs_AI/台账/<任务>/`。
- `docs_AI/记录/r06/assets/` 是任务 06 的**历史证据**，任何测试运行都不应再写它（R09-6）。作者端 E2E 的输出在 `test-results/author-e2e/`（gitignored）。
- **所有 runner 的输出都在 `test-results/<suite>/`**（R09-6/R09-19：作者端、07 GitHub 套件、07.5 独立套件、导航验证脚本等），`docs_AI/记录/` 下不再有任何 runner 写入；`npm run check:runners` 会拦住回退。
- 改动部署相关文件后，至少跑：`npm run check`（含 workflow/worker 守卫）、`npm run build`、`npm run check:dist`、`npm run test:e2e`。
