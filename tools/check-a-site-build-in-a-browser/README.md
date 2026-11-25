# check-a-site-build-in-a-browser

## Purpose

A program a site deploy runs on the computer that holds the built site, before it applies a commit. It opens each kind of page of the build in a headless Chromium beside the same page on the live site and refuses the build (exit 1) when a page is blank, throws a page error the live page does not, or shows its reading text in a serif default where the live page does not. It is the deterministic gate for what no server-side check sees: a page whose script throws, a stylesheet that did not load.

Why it exists: on Nov 24 2026 two site builds went live with every server check green. At 8:57 PM the home page's reading text fell back to Times and the testimonials and video library lost their styles; until 9:42 PM every `/courses/<slug>` page drew blank (a `toUpperCase` page error).

## Where it runs

`on-your-computer`, like `tools/check-a-rendered-video`, not `container`. The program must read the built folder, which sits on the computer that built it, and needs a Chromium. A container tool (`tools/page-critic`) reaches only the internet and the files it is given, so it could see neither the unapplied build nor a local server. It needs Node 24, a Chromium-family browser found as `tools/headless-browser` finds one (`browser-places.json`, or `BROWSER_EXECUTABLE` or `--browser`) and the Workshop checkout. It starts the browser through `tools/headless-browser/devtools.mjs` (DevTools over a pipe), so it adds no browser library; the test finds the Playwright Chromium through `test-helpers/chromium.mjs`.

## Invocation

Two ways to name what is checked, exactly one each time (else exit 2):

- **A built folder** (`--pages`, with `--app`): the commit's built pages, served on 127.0.0.1 by `serve-build.mjs`.
- **A candidate** (`--candidate`, with `--candidate-app`): a new unit with no built folder (a site drawn from rows), placed beside the live unit at a side address (`http(s)://host:port`) or a unix socket (`unix:/path`). `serve-candidate.mjs` is a loopback door that asks the candidate everything (data calls too) as the live host (Host, Referer, Origin, X-Forwarded-Host/Proto) and turns redirects to the live origin back to itself. The kinds are the `--paths` given (paths on live, or whole addresses on another live host such as the app's sign-in) plus the candidate's own sitemap. Besides the three refusals, a candidate page is refused when its first answer (status; a redirect's target) or the path the browser ends on differs from live's, so a members page is held to live's signed-out answer without signing in.

```
node tools/check-a-site-build-in-a-browser/do-work/check-site-build.mjs --candidate https://SIDE_HOST:PORT --live https://LIVE_HOST [--candidate-app unix:/run/app.sock --live-app https://LIVE_APP_HOST] [--paths /,/members,https://LIVE_APP_HOST/sign-in] [--out PICTURES_DIR]
```

```
node tools/check-a-site-build-in-a-browser/do-work/check-site-build.mjs --pages BUILT_PAGES_DIR --live https://LIVE_HOST [--out PICTURES_DIR] [--app BUILT_APP_DIR --live-app https://LIVE_APP_HOST] [--server-rendered /PREFIX,/PREFIX] [--settings FILE] [--browser EXECUTABLE]
```

A workflow step runs it the way the host runs every on-your-computer tool: the step's input is written to a request file and the row's `run` is `--request {request}`. The file holds `{pages, live, out?, app?, live_app?, server_rendered?, commit?}` (`''` is no value). Without `out` (or `--out`) the pictures go to `settings.json` `pictures_folder` (`$XDG_DATA_HOME`, else `~/.local/share`, then `site-build-checks`) `/<commit or the time>`, so a gate's evidence outlives its run. With `commit`, each built folder's path must hold that full id, or nothing is checked (exit 2), so an older build cannot stand in.

Standard output is one JSON line `{"result": {"refused": N, "not_checked_here": M, "pages": [{kind, url, live_url, height_px, live_height_px, height_to_live, new_page_errors, reading_font, live_reading_font, serif_where_live_is_not, visible_text_chars, parts, live_parts, fewer_parts, screenshots: {local, live}, refused, checked_here, why}]}}`; progress goes to standard error, which ends with the refusal summary: one line per refused kind (`REFUSED <kind>: <reasons>`, at most `summary_line_chars`), then `<N> page kind(s) refused: <kinds>`. A workflow keeps only the last 600 characters of a failed step, and they always name every refusal. Exit 1 when any page is refused, 0 when none is, 2 when it could not run (bad arguments).

## The rules

1. Page kinds come from the build's own lists (`do-work/page-kinds.mjs`): the locs of `sitemap.xml` grouped by path shape (one segment is its own kind; two or more segments are the kind of the parent folder, `/courses/*`), plus the top-level `.html` pages the sitemap leaves out, plus the app folder's. One page per kind: the first the sitemap lists.
2. Each is opened from the build (served on 127.0.0.1: path, folder `index.html`, `path.html`; data calls under `/target/` and files the build lacks go to the live site, data calls with no query added and with Referer and Origin naming the live host) and from the live site. Page views carry `utm_content=check`.
3. Measured after the load event (never network idle) plus `settle_ms`: scroll height, page errors, computed font-family of the first `#root p`, visible text length.
4. Refused: built height under `min_height_to_live` of live; no visible text where the live page shows some (a blank page is a full window tall, so it passes the height rule against a short live page such as a sign-in); a page error the live page did not throw; a serif reading font where live's is not; under `min_parts_to_live` (0.8) of live's count of any kind of part a person sees (`settings.parts`: pictures that loaded, videos that can play, controls, form fields) that live shows at least `min_live_parts` (2) of, so a page with live's words but not its pictures, players, buttons or forms is refused (the Nov 25 2026 home from rows passed every other rule with 3 of live's 9 pictures, 7 of 19 controls and none of its 3 form fields). A kind the live site answers 404 for (any other live status of 400 or more refuses the page as unreadable): refused for any page error or no visible text. A page the build has no file for, or that does not load, is refused. The one exception is named by the caller: a kind under a `--server-rendered` prefix (whole path segments: `/articles` covers `/articles` and `/articles/x`, not `/articlesx`) is drawn by the commit's server code from its data, which a built folder cannot show; its row says `checked_here: false` and `words.server_rendered`, it is neither refused nor passed, and `not_checked_here` counts it. The deploy checks those kinds on the running commit after its apply.

A blank page is only as tall as the window (`scrollHeight` is never under the viewport), so a blank page measures 900 px against a live page of thousands.

## Files

| File | Purpose |
|------|---------|
| `settings.json` | DATA: window size, wait times, `min_height_to_live` (0.5), `parts` with `min_parts_to_live` (0.8) and `min_live_parts` (2), the reading selector, the serif pattern, the check query, the data-call prefix and every sentence a refusal says. |
| `do-work/check-site-build.mjs` | The command and `checkSiteBuild({ pages, app, live, liveApp, out, settings, browser })`. |
| `do-work/page-kinds.mjs` | `pageKinds(root, settings)`: the kinds from the sitemap and the folder. |
| `do-work/serve-candidate.mjs` | `serveCandidate({ candidate, live, settings })`: the loopback door to a candidate, asked as the live host. |
| `do-work/serve-build.mjs` | `serveBuild({ root, live, settings })` and `fileFor`: the local front door with pass-through. |
| `do-work/measure-page.mjs` | `measurePage({ url, shot, settings, browser })`: one page in Chromium. |
| `do-work/judge.mjs` | The refusing comparisons. |
| `tool-rows.json`, `kits/check-a-site-build-in-a-browser.json` | The row `tool:check-a-site-build-in-a-browser` and its kit. |
| `part.json` | Nothing here is imported by other code. |
| `test/check-site-build.test.mjs` | Made-up built and "live" sites on two local servers: a blank course with a `toUpperCase` error, a serif home, a matching page, a new kind with and without errors, a missing file, the command's exit codes and the pass-through headers. |

## Key Types / Functions

| Name | Signature | Role |
|------|-----------|------|
| `checkSiteBuild` | `({ pages, app?, live, liveApp?, out, settings?, browser? }) => Promise<{ refused, pages }>` | The whole gate. |
| `pageKinds` | `(root, settings) => [{ kind, path }]` | One page per kind from the sitemap and folder. |
| `serveBuild` | `({ root, live, settings }) => Promise<{ origin, close }>` | The local front door with pass-through. |
| `measurePage` | `({ url, shot, settings, browser }) => Promise<{ height, font, text, errors }>` | One page in Chromium. |
| `judge` | `({ kind, url, liveUrl, built, live, shots, settings }) => row` | The refusing comparisons. |

## Dependencies

**Depends on:** `tools/headless-browser/devtools.mjs`. **Depended on by:** nothing yet; a site deploy workflow calls it before its apply step.
