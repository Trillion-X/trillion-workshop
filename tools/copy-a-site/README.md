# tools/copy-a-site

Copies a live website into the file map a public app is published from: each page as a visitor sees it once its scripts have run (scripts taken out), plus the pictures, styles and fonts the pages use from the same site. Large sites continue in bounded runs (`paths`, `exclude_paths`).

## Files

| File | Purpose |
|------|---------|
| `part.json` | What other parts and tools may use from this part. |
| `do-work/copy-a-site.mjs` | Opens each page in a headless browser, follows same-site links and a bounded same-site sitemap, fetches the files the pages use, reports pages left for another run, and leaves `<out>/site.json`; prints one JSON line. |
| `do-work/copy-addresses.mjs` | The route and link rules: the file a page is kept as, and how addresses in a page or style sheet are pointed at the copy. |
| `tool-rows.json` | The Workshop row for this folder: `tool:copy-a-site`, an internet:true container row that packs `do-work` and `tools/headless-browser`'s `devtools.mjs` and `quiet-switches.json`. |
| `test/` | The copier run on a small site reached only through a proxy (Playwright's Chromium), and its naming, sitemap and page-limit rules. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `pageFile` | `(pathname: string) => string` | The file a page is kept as: `/` is `index.html`, `/a/b` is `a/b/index.html`, `/a.html` stays `a.html`. |
| `assetFile` | `(url: URL, contentType: string) => string` | The file an asset is kept as, with the extension the host serves for the type the site answered, and a query string folded into the name. |
| `sitemapPages` | `(origin, fetchPage = fetch) => Promise<string[]>` | Same-origin page paths a sitemap or sitemap index lists, at most 8 sitemap files and 1 MB each. |
| command | `node do-work/copy-a-site.mjs --url <address> --out <folder> [--max-pages 60] [--paths '["/a"]'] [--exclude-paths '["/kept"]'] [--width 1280] [--height 900] [--browser <path>]` | Prints `{ origin, pages[], remaining_paths[], redirects[], asset_paths[], files, bytes, skipped[], all_skipped[] }`; `site.json` is `{ files: { path: text \| data URL } }`. |

## Dependencies

**Depends on:** `tools/headless-browser` (`devtools.mjs`, a Chromium spoken to over DevTools with `quiet-switches.json`); Node's own `fetch` and `WebSocket`; a Chromium (`--browser` or `BROWSER_EXECUTABLE`).

**Depended on by:** the Workshop row `tool:copy-a-site` (`tool-rows.json`).

## Invariants

- Nothing here names a site, product or brand: the start address, page limit and extra paths are input.
- Only the start address's own origin is copied or followed; other sites stay linked where they are.
- A kept page carries no script, inline event handler, frame or `<base>`; script files are never kept, since a public app serves only its own scripts and the copy is the rendered result.
- A page or file that cannot be copied is listed under `skipped` with the reason in plain words; omitted links keep their original addresses. Past 100 findings, the last row says how many more were left out. A start page that cannot be copied ends the run with the reason.
- No address rule lives here. The start must be a web address (http or https, no user name or password); which addresses are public is the engine's to judge: it runs the row as internet:true, so the copier's fetches and its browser reach only the engine's public-only proxy, which judges every address and redirect.
