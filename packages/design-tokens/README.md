# @selfpage/design-tokens

Single source of truth for SelfPage color, typography, spacing, motion and shell dimensions.

## Import

```astro
---
import '@selfpage/design-tokens/tokens.css';
---
```

Consumers must not duplicate token values in component CSS. If a value is missing, add a semantic token here rather than hard-coding it in a page.

## Color

`tokens.css` sets `color-scheme: light dark` on `:root` and resolves semantic colors with `light-dark()`. The system preference therefore works before JavaScript runs. A `prefers-color-scheme` fallback is included under `@supports not (color: light-dark(...))`.

| Token | Dark | Light |
|---|---:|---:|
| `--color-page` | `#151517` | `#FFFFFF` |
| `--color-sidebar` | `#1B1B1B` | `#F5F5F5` |
| `--color-popover` | `#2C2C2E` | `#F0F0F0` |
| `--color-text` | `#F2F2F2` | `#202020` |
| `--color-text-secondary` | `#C9C9C9` | `#474747` |
| `--color-border` | `#454547` | `#D4D4D4` |
| `--color-link` | `#A8B8C8` | `#405F78` |
| `--color-focus` | `#9CC7FF` | `#0B57D0` |
| `--color-state-surface` | `#2D2D2D` | `#E8E8E8` |

`--color-state-surface` is the opaque composite of the translucent `--color-state-overlay` over `--color-sidebar`; using it directly guarantees the exact measured state color. Task 03 uses it for current and hover backgrounds. The article/page background is `--color-page`, never `--color-popover`.

Task 08 can add `data-theme="light"` / `data-theme="dark"` on `<html>`; the token file already maps those attributes to `color-scheme`, which flips `light-dark()` without duplicating values. Do not set a root `font-size` for Text Size; override typography tokens such as `--font-size-body`.

## Typography

Sizes are `rem` and line heights are unitless. `--measure-prose: 80ch` is a text measure, not the article container width. `--size-topbar` and friends are intentionally `rem` so OS text scale keeps the shell proportional.

## Shell dimensions and layout

| Token | Default (16px root) | Meaning |
|---|---:|---|
| `--size-nav-item` | `3.5rem` / 56px | H: navigation button height |
| `--size-topbar` | `5.25rem` / 84px | T: top bar height |
| `--size-drawer-first-row` | `7rem` / 112px | S: drawer first row |
| `--layout-sidebar-inline` | `19.4%` | wide-screen drawer width |
| `--layout-article-inline` | `59%` | wide-screen `main` width |
| `--layout-article-offset-inline` | `30.2%` open / `20.5%` closed | wide-screen `main`/footer start offset |
| `--layout-topbar-offset` | `calc(T + safe-area-top)` | fixed bar offset used by the spacer and `scroll-padding-top` |

`main` is the article container. Above 48em it keeps 59% width, but the start offset depends on the drawer state: open centers it in the area right of the 19.4% drawer (center 59.7%, start 30.2%); closed centers it in the full viewport (center 50%, start 20.5%). At or below 48em it is 100% with required padding and no offset. The article container never becomes a chat bubble and the footer uses the same offset.

## Chrome positioning contract (task 03)

`--chrome-block-size`, `--chrome-block-start`, `--chrome-inline-start`, `--chrome-inline-end` and `--chrome-gap` position the single Menu button and brand in `TopBar.astro`. The drawer's S row must not re-center the chrome. Task 03 flips `data-drawer-open` on `<html>`; do not render a second Menu/brand or a second accessible brand string.

The static shell ships `data-drawer-open="true"`. The wide-screen closed state translates the drawer by `-100%` and is already expressed in `shell.css`; the toggle, backdrop, `inert`, Escape handling and focus restore belong to task 03.

## Motion

`--motion-duration-*` and `--motion-easing-standard` are the only timing values. They become `0ms` under `prefers-reduced-motion: reduce`. Task 08's explicit Reduced Motion setting should override the same tokens rather than adding per-component durations.

## Safe areas

`--safe-inset-top`, `--safe-inset-inline-start`, `--safe-inset-inline-end`, `--safe-inset-block-end` indirection to `env(safe-area-inset-*)`. Tests can override the custom property to simulate a notched device; production still reads `env()`. `viewport-fit=cover` is required in the viewport meta tag and is set in `BaseLayout.astro`.
