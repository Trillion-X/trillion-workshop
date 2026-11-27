# tools/compare-two-movements-side-by-side/

Two movements played next to each other, each from its own start second, with a title and a line of words. One row of the pursuit's `comparisons` table is one pair.

## Files

| File | Purpose |
|------|---------|
| `do-work/pair.ts` | `tool:read-movement-pairs`: reads every `comparisons` row in position order and answers `{ pairs }`. A row missing either video is refused by name. |
| `show/SideBySide.tsx` | The screen: `View(props)` is pure (no fetch, no window while it renders). Its props are the answer of the read; `filesBase` is put in front of a video that is a storage key. |
| `show/video-address.ts` | Turns a stored video value (an address or a storage key) into the address a player opens. Also used by `show-published-clips`. |
| `tests/` | The row to pair rules, the read's statement, and the screen drawn to markup with `tests/render-a-view.ts` (esbuild bundle, run once, no browser). |
| `what-this-tool-does-and-how-to-run-it.json` | The card. `screen` is `{ kind: module, entry: show/SideBySide.tsx, export: View }`; the read runs in a container on the pursuit's own database, opened with the login its vault holds. |

## How a page and an AI app get the same screen

The site tool (or an AI app) calls `tool:read-movement-pairs` with `{ database }`, and passes the answer to `View`. Nothing in this folder names a person, a brand or a page.

## Known gaps

- Pictures of the screen with real rows are taken when the site tool serves it; this folder proves the markup only.
