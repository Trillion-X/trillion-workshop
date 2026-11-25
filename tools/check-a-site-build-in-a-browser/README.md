# check-a-site-build-in-a-browser

A program a site deploy runs on the computer that holds the built site, before it applies a commit. It opens each kind of page of the build in a headless Chromium beside the same page on the live site and refuses the build (exit 1) when a page is blank, throws a page error the live page does not, or shows its reading text in a serif default where the live page does not. It is the deterministic gate for what no server-side check sees: a page whose script throws, a stylesheet that did not load.

Why it exists: on Nov 24 2026 two site builds went live with every server check green. At 8:57 PM the home page's reading text fell back to Times and the testimonials and video library lost their styles; until 9:42 PM every `/courses/<slug>` page drew blank (a `toUpperCase` page error).

## Where it runs

`on-your-computer`, like `tools/check-a-rendered-video`, not `container`. The program must read the built folder, which sits on the computer that built it, and needs a Chromium. A container tool (`tools/page-critic`) reaches only the internet and the files it is given, so it could see neither the unapplied build nor a local server. It needs Node 24, a Chromium-family browser found as `tools/headless-browser` finds one (`browser-places.json`, or `BROWSER_EXECUTABLE` or `--browser`) and the Workshop checkout. It starts the browser through `tools/headless-browser/devtools.mjs` (DevTools over a pipe), so it adds no browser library; the test finds the Playwright Chromium through `test-helpers/chromium.mjs`.

## Invocation

```
node tools/check-a-site-build-in-a-browser/do-work/check-site-build.mjs --pages BUILT_PAGES_DIR --live https://LIVE_HOST --out PICTURES_DIR [--app BUILT_APP_DIR --live-app https://LIVE_APP_HOST] [--settings FILE] [--browser EXECUTABLE]
```

Standard output is one JSON line `{"result": {"refused": N, "pages": [{kind, url, live_url, height_px, live_height_px, height_to_live, new_page_errors, reading_font, live_reading_font, serif_where_live_is_not, visible_text_chars, screenshots: {local, live}, refused, why}]}}`; progress goes to standard error. Exit 1 when any page is refused, 0 when none is, 2 when it could not run (bad arguments).

## The rules

1. Page kinds come from the build's own lists (`do-work/page-kinds.mjs`): the locs of `sitemap.xml` grouped by path shape (one segment is its own kind; two or more segments are the kind of the parent folder, `/courses/*`), plus the top-level `.html` pages the sitemap leaves out, plus the app folder's. One page per kind: the first the sitemap lists.
2. Each is opened from the build (served on 127.0.0.1: path, folder `index.html`, `path.html`; data calls under `/target/` and files the build lacks go to the live site, data calls with no query added and with Referer and Origin naming the live host) and from the live site. Page views carry `utm_content=check`.
3. Measured after the load event (never network idle) plus `settle_ms`: scroll height, page errors, computed font-family of the first `#root p`, visible text length.
4. Refused: built height under `min_height_to_live` of live; a page error the live page did not throw; a serif reading font where live's is not. A kind the live site answers 404 for: refused for any page error or no visible text. A page the build has no file for, or that does not load, is refused.

A blank page is only as tall as the window (`scrollHeight` is never under the viewport), so a blank page measures 900 px against a live page of thousands.

## Files

| File | Purpose |
|------|---------|
| `settings.json` | DATA: window size, wait times, `min_height_to_live` (0.5), the reading selector, the serif pattern, the check query, the data-call prefix and every sentence a refusal says. |
| `do-work/check-site-build.mjs` | The command and `checkSiteBuild({ pages, app, live, liveApp, out, settings, browser })`. |
| `do-work/page-kinds.mjs` | `pageKinds(root, settings)`: the kinds from the sitemap and the folder. |
| `do-work/serve-build.mjs` | `serveBuild({ root, live, settings })` and `fileFor`: the local front door with pass-through. |
| `do-work/measure-page.mjs` | `measurePage({ url, shot, settings, browser })`: one page in Chromium. |
| `do-work/judge.mjs` | The refusing comparisons. |
| `tool-rows.json`, `kits/check-a-site-build-in-a-browser.json` | The row `tool:check-a-site-build-in-a-browser` and its kit. |
| `part.json` | Nothing here is imported by other code. |
| `test/check-site-build.test.mjs` | Made-up built and "live" sites on two local servers: a blank course with a `toUpperCase` error, a serif home, a matching page, a new kind with and without errors, a missing file, the command's exit codes and the pass-through headers. |

## Dependencies

**Depends on:** `tools/headless-browser/devtools.mjs`. **Depended on by:** nothing yet; a site deploy workflow calls it before its apply step.
