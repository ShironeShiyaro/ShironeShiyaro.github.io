# 注意：本目录是 07.5 的历史证据，不属任何质量门禁

`tests/independent-075/` 是任务 07.5 独立测试者当时的验收脚本与取证工具，**原样保留**作为历史证据（`docs_AI/记录/r075/02-独立测试.md` 的依据）。

## 它现在会给出"假失败"，这是预期的

任务 08 按用户口径与总控裁定**改变了**下列语义，本目录里的断言因此过时：

| 旧断言 | 08 之后的正确语义 | 依据 |
|---|---|---|
| 侧栏 Settings 是纯文本 `<span>` 占位 | Settings 是指向 `/settings/` 的真实 `<a>`，带 `aria-current="page"` | R08-2 |
| 公开站 New! 的 `href` 精确等于 `${AUTHOR_ORIGIN}/new/` | 客户端会把**非敏感偏好 fragment**（`#theme=…&motion=…&size=…`）追加到 `[data-new-href]` 的锚点上；SSR 的 href 仍是不带 fragment 的原文 | R08-4 |

## 纪律

- **不要**为了让这里变绿去改它，也**不要**把它的失败当成当前产品缺陷。
- **不要**把这些文件接进 `tests/run-e2e.mjs`、`tests/run-author-e2e.mjs` 或 `tsconfig.tests.json`。
- 需要验证 08 语义时，用 `tests/e2e/settings.spec.ts`、`tests/e2e/a11y.spec.ts`、`tests/author-e2e/preferences.spec.ts`。
- 总控裁定（2026-11-26，见 `docs_AI/台账/08-设置与可访问性/00-总台账.md` §12.2 C5）：保持原样，不做更新。
