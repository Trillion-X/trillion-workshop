# bloxwap/bloxwap.github.io

- Source: https://github.com/bloxwap/bloxwap.github.io @ 10db2fe240570de573a45ec07ee7d6afa2075ad4 (2026-10-27)
- Licence: none for the repository. No LICENSE file; `package.json` is `"private": true` with no `"license"` field. `llms.txt` says the Chart, Hyperliquid, SFX and Haptic projects are MIT and the Font is OFL-1.1, but those statements are about the other repositories, not this site. Treat this repo as all rights reserved: ideas only. Code from it may not be copied into an Apache-2.0 or MIT project.

## What it does

It is the root GitHub Pages site for Bloxwap's open-source projects: a home page, a developer portal (`developers/index.html`), a privacy page and a 404 page, all hand-written static HTML with one stylesheet. It links to the separately deployed project sites (`/chart/`, `/hyperliquid/`, `/sfx/`, `/haptic/`, `/font/`, `/screensaver/`) and publishes `llms.txt`, `robots.txt`, `sitemap.xml` and an Open Graph card (`og/home.png`). CI builds design-token and font assets from pinned npm packages, runs static and browser checks, and deploys the tested directory to Pages.

## How it is built

- Pages: `index.html`, `developers/index.html`, `privacy/index.html`, `404.html`; `styles.css`; `lockup.svg`; `og/home.png`. Head of each page carries canonical link, OG and Twitter card tags (with image width, height and alt), an `<link rel="alternate" type="text/plain" href="/llms.txt">`, and JSON-LD (`@graph` with an Organization).
- `llms.txt`: an H1, a `>` summary line, then "When to use this" and "How to call it" sections per project with a short code sample, a "Docs" list of links with one-line descriptions (including links to each sub-site's own `llms.txt`), and a "Company" section.
- `robots.txt`: allows all, then a group that explicitly allows named AI crawlers (GPTBot, ClaudeBot, Claude-User, PerplexityBot, Google-Extended, CCBot and others), and lists three sitemaps.
- `sitemap.xml`: hand-maintained, with `lastmod` per URL, covering this site and the sub-sites.
- `scripts/` (Node built-ins plus Playwright only): `sync-hig.mjs` (generates `assets/hig/` and `assets/font/` from `@bloxwap/hig-tokens` and `@bloxwap/font`; `--check` verifies bytes), `check.mjs` (static checks), `check.test.mjs` (node:test planted-failure tests), `drift.mjs` (runs the design system's drift checker from a pinned commit using `hig-drift.json` scope), `og.mjs` + `og-card.html` (renders the OG PNG with Playwright), `evidence.mjs` (before/after screenshots and byte report), `serve.mjs` (local static server).
- `tests/site.spec.mjs` + `playwright.config.mjs`: browser tests.
- `evidence/hig-61/`: README with before/after screenshots at 1440px and 390px, OG before/after, and `before-bytes.json`/`after-bytes.json` per-request byte reports.
- `hig-drift.json`: the paths the drift check covers, with empty `canonical`, `obsoleteImports` and `exceptions` lists. `docs/hig-release.json` pins the design-system commit and registry integrity.
- Dependencies (dev only): `@bloxwap/font` 0.1.2, `@bloxwap/hig-tokens` 0.1.0, `@playwright/test` 1.56.1.
- CI: `.github/workflows/ci.yml` (security scan via the org reusable workflow on non-PR runs; `site` job: npm ci, build, check, drift, Playwright; copies to a temp dir, asserts required files exist, uploads the Pages artifact; `deploy` job needs both). Plus `security-pr.yml`, `security-nightly.yml`, `security-weekly.yml` calling the org workflows. `renovate.json` extends the org preset.

## Reusable techniques worth learning

1. **Static share-card and head checks** (`scripts/check.mjs`, pages section). For every indexed page it requires `og:title`, `og:description`, `og:url`, `og:image`, `og:image:width`, `og:image:height`, `og:image:alt` and `twitter:card=summary_large_image`, and it reads the PNG header bytes to confirm the card is 1200x630. The evidence README shows this caught real bugs (a page pointing at another site's card, pages missing dimensions). Cheap, no browser needed.
2. **Planted-failure tests for a checker** (`scripts/check.test.mjs`). The checker accepts an environment variable naming an alternative stylesheet; the test copies the real file, appends one bad declaration, runs the checker as a subprocess and asserts it fails with the expected message, plus a list of tricky inputs that must still pass. A clean way to prove a linter's rules both fire and do not over-fire.
3. **Design-token-only CSS lint** (`scripts/check.mjs`, styles section). Colours, type, spacing, radius, motion and heights must come from `var(--hig-*)` roles that exist in the generated token file; hex, colour functions and named colours are rejected anywhere in a value, and px heights are banned so components scale with root text.
4. **Browser accessibility and reflow checks** (`tests/site.spec.mjs`). Tabs through every link and asserts each gets a solid 2px focus ring in the focus colour and that focus order equals document order; checks there is no horizontal overflow at 320px, 390px and at 1280px with root font size set to 200%; checks logos double in size at 200% text; fails on any failed sub-request.
5. **llms.txt written as "when to use / how to call"** (`llms.txt`). Each project gets a usage decision ("use it when ... do not use it for ...") and a 3–5 line call example, with links to deeper per-project llms.txt files. robots.txt names AI crawlers explicitly, and each page links to llms.txt with `rel="alternate" type="text/plain"`.
6. **Before/after evidence with a byte report** (`scripts/evidence.mjs`, `evidence/hig-61/`). Records every same-origin response per page with raw and gzip -9 sizes, groups by HTML/CSS/fonts/images, records document height and whether the page overflows, and saves full-page screenshots at two widths. Gives a reviewer numbers, not just pictures.
7. **Rendering the OG image from HTML** (`scripts/og.mjs`, `scripts/og-card.html`). A 1200x630 HTML card is screenshotted with Playwright after asserting the brand fonts loaded, so the share image uses the same tokens as the site.
8. **Deploy exactly what was tested** (`.github/workflows/ci.yml`). The tested checkout is rsynced to a temp directory, a fixed list of required paths is asserted, and that directory is the Pages artifact; deploy waits on both the site tests and the security scan.

## Fit with trillion-workshop tools

- **ai-readiness** (`tools/ai-readiness/read-data/ai-readiness-checks.json`, `do-work/audit-served-html.mjs`): real fit. The audit has no share-card check today (no check mentions `og:` or `twitter:`), and its check rows are pure DATA. A new unscored row, for example `has-share-card`, can be written with the existing `all_of` + `elements` shape (`tags: ["meta"]`, `attr_matches: {"property": "^og:title$"}` etc., plus `name: ^twitter:card$`), with no engine change. Its robots checks are also DATA (`robots: {agent, path}`), and today only `meta-webindexer` is checked; rows for other named answer-engine crawlers would follow the same shape.
- **publish-content-for-discovery** (`do-work/prepare-content-for-discovery.mjs`): partial fit. Its `llms.txt` output is a title, then per document a heading, URL, description, schema properties and sources. The Bloxwap llms.txt shows a richer layout (a `>` summary line, "when to use" guidance). Adding an optional site summary line would be small, but needs a new input field and test, so it is a second choice.
- **page-critic** (`read-data/page-craft-rules.json`): possible fit. It already checks overflow at its widths, but not reflow at 200% root text or keyboard focus visibility. Those would be new `MEASURES` entries, larger than a small change.

## Cautions

- No licence for this repo: do not copy `check.mjs`, `site.spec.mjs`, `evidence.mjs` or the llms.txt text. Write any equivalent independently.
- Many checks are brand-specific (exact stylesheet order, the approved favicon, a fixed lockup SHA-256, a fixed OG URL); only the general ideas transfer.
- `sitemap.xml` is hand-maintained with hand-set `lastmod` dates.
- The evidence JSON contains a local machine path (`root`), which suggests evidence files are committed from a developer machine.
- CI depends on self-hosted macOS runners and a private-looking design-system checkout (`bloxwap/hig`).
