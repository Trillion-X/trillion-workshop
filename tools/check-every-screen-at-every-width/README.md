# parts/screen-matrix/

One headless check both Trillion deploys run before going live: every screen, in every width and every way a person may have their device set, is opened and every piece of text a person can see is read. `scripts/deploy-worker.mjs` runs it on the app's own Worker; trillion-site's `scripts/check-screens.mjs` (deployed through `source-build-lock.json`, which carries this part) runs the same engine on its built pages.

## Files

| File | Purpose |
|------|---------|
| `check-screens.mjs` | The engine: `runMatrix`, `summarise`, `openOrigin`, `openExtension` and a command line (`node check-screens.mjs --origin URL --screens FILE`). Opens each screen row at each width in each mode in its own browser context (a pool of `pool` at a time), waits for the fonts and the network, scrolls the page window by window, reads the text, and judges it. |
| `in-page.mjs` | What runs inside the page (`readPageFacts`, `readWindow`) and inside a plain decoder page (`samplePixels`): reads, never judges. |
| `views.json` | DATA: the widths (phone 390x844 with no sideways scroll, tablet 820x1180, desktop 1440x900), the modes (light, dark, forced colours, Dark Reader, a real extension), the thresholds, the pool and the timings. |
| `allowlist.json` | Failures proven to be false positives, each with its reason (empty is the goal), and looks the person decided (a row with `decided`): those failures are reported in the run and its report and never refuse a deploy. |
| `vendor/darkreader.js`, `vendor/LICENSE` | Dark Reader 4.9.133 (MIT), taken unchanged from `npm pack darkreader`; injected with an init script and enabled with the options the mode row names. |
| `part.json` | The files code outside this part may import. |

## Probes

Each reads every visible text node (not hidden, not `aria-hidden`, not zero-size, not transparent, not clipped away); a failure is `{ screen, width, mode, probe, selector, text, detail }`.

| Probe | Fails when |
|-------|-----------|
| `contrast` | The text is under WCAG AA (4.5, or 3 for text of 24px or more, or 18.66px or more at bold) against the colour really behind it: the ancestor backgrounds composited with their alpha and opacity, or, where the text sits over a background image, gradient, backdrop filter or blend, is SVG, or has a halo, the picture itself (the ground is the commonest colour just outside the text box and the ink the brightest pixel inside it). |
| `font` | Glyphs are drawn by a platform font (DevTools `CSS.getPlatformFontsForNode`) that the screen row does not declare in `fonts` (nor emoji, in `always_allowed_fonts`). Text whose whole `font-family` is system names (`ui-monospace`, `system-ui`, generics: `system_font_names`) asks for the platform's own font and never counts as a fallback. |
| `overflow` | Text is cut by an ancestor or its own box with `overflow: hidden/clip` and no ellipsis or line-clamp, or a text box is partly outside the window sideways. A nearer ancestor that ends the line with an ellipsis also counts for the ancestors outside it. |
| `horizontal-scroll` | At a width flagged `no_horizontal_scroll` the page is wider than the window. |
| `decided-colour` | Text on or in a colour the person decided for their look (`views.json` `decided_colours`) still misses that colour's own bar (the thread red's white semibold words are judged at 3:1). Reported in the run and its report, never a refusal: the check never makes anyone change a decided look value. |
| `control_name` | A DATA-selected rendered control has an empty Chromium-computed accessible name, or its accessibility-tree evidence is unavailable, ambiguous, or changed around measurement. The shared page-craft measure reads the top-level document in the release matrix and joins Chromium nodes to current DOM controls by a class-free structural identity path. It compares node identity, role, name, visibility and availability before and after measurement; geometry-only movement and proven-hidden control additions or removals do not invalidate the name evidence. |
| `open` | A screen did not open (a screen that does not open is a failure, never a skip). |

## How a run is kept fast

- One load of a screen at a width serves every mode that is only media emulation (`apply: "live"`): light, dark, forced colours and, after them, Dark Reader switched on in the already-open page. Only a mode that needs its own load (an init script, the real extension) loads again.
- A page is read when it has drawn (two animation frames) and its requests have been quiet for `quiet_ms`, not after fixed waits. Text well below the window is read when the scroll reaches it; text half inside a scroller (an edge that fades or cuts it) is first scrolled to the middle of it.
- Font queries are asked once per distinct font setting per page load (`fontKey`) over one held DevTools session.
- The shared check reports seconds per phase (`report.timing`, printed by `summarise`) so a slow phase shows where it is.
- A host that serves the pages from a Worker can answer the long-lived files (immutable chunks, `/workspace/named/*`) from disk or a cache: a routed Playwright context has no HTTP cache, so each page would otherwise fetch hundreds of them through the Worker (`cacheStatic` in `scripts/worker-in-browser.mjs`).

## Screens files

A deploy's `scripts/screen-matrix-screens.json` holds `{ defaults: { fonts, ready }, screens: [{ id, route, fonts?, ready?, steps?, widths?, modes? }] }`. `ready` is `{ selector, state?, gone? }`: what must be on the page (visible unless `state` says attached), and what must be gone from it, before it is read. `settings` overrides `views.json` fields (`pool`, `open_within_ms`) for pages that need them.

## Real extension

`--extension DIR` (command line) or `extension` (`runMatrix`) adds the `darkreader-extension` mode: persistent headless contexts that carry the unpacked extension. Without it that mode is skipped.

## Dependencies

**Depends on:** `parts/headless-browser/launch.mjs` (the quiet launches), `playwright`.
**Depended on by:** `scripts/deploy-worker.mjs`, `test/screen-matrix.test.mjs`, and trillion-site's `scripts/check-screens.mjs`.

## The app's deploy set and the full set

The app's screens are in `scripts/screen-matrix-screens.json`. A row with `"deploy": true` is one of the main screens; each deploy
reads only those (every width and every mode), about a minute and a half of an idle machine. The full set (every screen with an address)
is one command:

    node scripts/check-app-screens.mjs --all [--out dist/deploy] [--report FILE] [--shots DIR]

`scripts/deploy-worker.mjs` also reads the full set when the diff from the live commit touches a path in the file's `all_when_changed`
(`parts/ui/`, `parts/screen-look/`, `src/workspace/looks.json`: the shared components, the look resolver and the look data move every
screen). With no live commit to compare with (a local run, a first deploy) only the marked screens are read. Run `--all` by hand
before landing a change to a screen outside the marked set.

`views.json.craft_rules` selects structural measurements from the shared page-critic owner. The same `eyebrow` and `inline_icon_scale` rules read rendered headings and prose before a release; findings use the normal matrix refusal path. Unknown configured rules refuse instead of silently passing.
