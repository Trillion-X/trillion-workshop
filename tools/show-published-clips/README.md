# tools/show-published-clips/

A strip of clip stills in one row that scrolls sideways. A still is shown; the video starts when the still is tapped.

## Files

| File | Purpose |
|------|---------|
| `do-work/clips.ts` | `tool:read-a-strip-of-published-clips`: reads the published `clips` rows that have both a still and a video, in position order, at most `limit` (24 by default, 1 to 100). |
| `show/ClipStrip.tsx` | The screen: `View(props)` is pure. Which clips play is the host's: it passes `playing` (clip ids) and wires `onPlay(id)`, or reads `data-clip-play` on each still's button. Built from the shared `Text`, `MediaFrame` and `Button`; no raw HTML, no inline styling. |
| `tests/` | The read's rules and statement, and the strip drawn to markup. |
| `tool-rows.json` | The card; `screen` names `show/ClipStrip.tsx` and its `View`. |

## Known gaps

- Picture proof with real stills and videos is taken when the site tool serves the strip.
