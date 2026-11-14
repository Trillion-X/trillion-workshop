# parts/ui/show/thread-cover

What covers Trillion while it opens, the same on every device: the landing page's red thread pulled by the logo's needle (the needle draws it all over the page, pulls it in until it bunches into a ball, pulls it out straight and sets off again, always heading the way it moves), a quote in the middle that is different every time, and, when Trillion is ready, a lift through a dissolving gradient mesh.

## Files

| File | Purpose |
|------|---------|
| `thread-cover.mjs` | The cover: `runThreadCover` draws and plays it and returns `{ lift() }`; `threadCoverHtml` writes it into a page's first bytes (element, rules, inline script); `threadCoverPage` is the cover as a page by itself (a host app's own cover); `mountThreadCover` draws it over a page that already runs scripts. |
| `thread-cover.json` | DATA: the quotes (words and who said them), the timing of each part of the thread's loop and of the dissolve, the paper, ink, thread and mesh colours, the quote's type, the logo's needle (`needle`: body, eye, angle, length, how fast it turns to head the way it moves), how the thread is drawn (`thread`: points, how many places the needle steers through as it draws, how tightly it turns, the area the strewn thread lies in, clear of the quote) and where the straight thread lies (`layout`: row, left, right as window shares, needle size). |
| `../../../../test/thread-cover.test.mjs` | (test) The cover is in a workspace page ahead of its script, its script stands alone, the host mode hands the lift to the app, the iPhone copy is current. |

## Key Types / Functions

| Export | Signature / Shape | Role |
|--------|-------------------|------|
| `runThreadCover` | `(geometry: {random, tangle, curve}, root: HTMLElement, settings) => { lift(): Promise<void> }` | Whole in itself, so it travels into a page as text. Draws the thread and needle on an SVG, picks a quote not shown last time on this device (`localStorage` `trillion-cover-quote`), plays the loop (draw, gather into the ball, hold, pull straight, rest; the needle turns smoothly to head the way its eye moves and keeps its heading while still), and on `lift()` blooms the mesh and opens holes until the cover is gone, then removes `root`. Reduced motion: still straight thread, a fade. |
| `threadCoverCss` | `(look) => string` | The cover's rules: `trillion-cover` fixed over the whole window, opaque, above everything. |
| `threadCoverHtml` | `(settings?) => string` | Rules, the `trillion-cover` element and an inline script that sets `window.trillionCover`. With `window.__trillionCoverHost` set, the page draws nothing; `lift()` posts `ready` to the host's `trillionCover` message handler and settles when the host calls `window.trillionCover.lifted()` (its own cover has finished dissolving), or after the dissolve's time and a margin. |
| `threadCoverPage` | `(settings?) => string` | A whole page holding only the cover. |
| `coverNeedleSvg` | `(settings?) => string` | The needle alone pointing right, eye at the centre, 2.2 needle lengths square: a host app draws it with the straight thread as the cover's first frame (the loop starts at the straight thread, so the page's first frame lands on it). |
| `mountThreadCover` | `(doc?, settings?) => { lift() }` | Adds the rules once and draws a cover into `doc.body`. |

## Usage

- The workspace page: `pageShellHtml({ opening_cover: true, … })` (`../server-rendered-page/page-sections-html.mjs`) puts `threadCoverHtml()` first in the body; `src/workspace/main.tsx` calls `window.trillionCover.lift()` once the workspace has painted, and lets what moves behind the page show (`../page-backdrop` `markPageOpen`) only after the dissolve has finished, so the two never change the window at once.
- The iPhone app draws the first frame natively at once (straight thread from `layout`, needle from `coverNeedleSvg()`), shows `threadCoverPage()` over it (both generated into the app's resources by `scripts/make-opening-cover.mjs`) and tells its page it is the host, so one cover plays until the page is ready; when its cover has dissolved it calls the page's `window.trillionCover.lifted()`.
- The workspace lifts the cover once every open screen shows its real content, or at the latest `COVER_OVERALL_MS` (8 s) after the page started, whatever its reads are doing, onto what is drawn (`src/workspace/main.tsx` invariant 8, `src/workspace/opening-cover.mjs`).
- The Mac app shows the page's own cover. The Chrome extension's windows draw it with `mountThreadCover` while they load.

## Invariants

- Opaque, full-window, above every layer: nothing behind it shows until it dissolves.
- Painted from the page's first bytes; the page waits on nothing for it, and it is lifted the moment Trillion is ready.
- The drawing is the landing page's (`../scroll-thread/thread-geometry.mjs`) and the logo's needle; words, timing and colours are DATA.

## Dependencies

**Depends on:** `../scroll-thread/thread-geometry.mjs`.
**Depended on by:** `../server-rendered-page/page-sections-html.mjs` (`opening_cover`), `src/workspace/main.tsx` (lift), the iPhone app's opening cover (`scripts/make-opening-cover.mjs`), the Chrome extension's popup.
