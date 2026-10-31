# tools/take-me-there/

Takes a person to the thing that needs them instead of telling them about it. `tool:take-me-there` takes one card of what waits on them (from the answer of `tool:what-is-waiting-on-me`), and gives back the screen to open, the arrangement that opens it as the main pane (with what the caller names beside it), the walkthrough whose step points at the card's own control, and the notice that links to both. Ported from the app's `src/take-me-there.mjs`, as the decision only.

Saving the arrangement and the walkthrough and sending the notice are the caller's, not this tool's: no engine record kind keeps saved arrangements, walkthroughs or notices yet, so this tool returns each as data and writes and sends nothing. Whoever owns them saves what it returns; the ids of the arrangement and the walkthrough are the thing's held key, so saving the same thing again changes the one copy.

The tool names no screen, source, kind of work or person. The screen an address opens comes from the caller's `screens` rows, `{ path_prefix, tool_id, route_input_from_query?: [names] }` (the longest prefix holding the path, by whole segments; the named query fields become the screen's own route input). Whether a link opens inside the person's own places comes from `own_origins`. The notice kind, default category, pane sizes, fallback selector and every word are DATA in `read-data/take-me-there.json`.

A thing that is not waiting now, or whose link leads outside `own_origins` or to a path no `screens` row holds, answers `{ taken: false, said }` and nothing else, so no walkthrough is ever made over an empty screen. A walkthrough is made only from `steps` the caller gives: a step with no target points at the card's `points_at` selector (the item's id filled in), else the fallback selector (the request's `fallback_points_at`, else the DATA one).

## Files

| File | Purpose |
|------|---------|
| `read-data/take-me-there.mjs` | `takeMeThere`: finds the card or batch, resolves its link to a screen, and builds the arrangement, walkthrough and notice. Its header lists the invariants. |
| `read-data/take-me-there.json` | The link parameter names, notice kind, category, sizes, fallback selector, walkthrough trigger and the words of every answer. |
| `do-work/take-me-there.mjs` | The command of the tool. |
| `tool-rows.json` | The row, with a sample run. |
| `part.json` | Nothing here is imported by other code. |
| `test/take-me-there.test.mjs` | Made-up cards, screens and origins: one pane and its route input, the split, the refusals (not waiting, outside, no screen), prefix choice, the control a step points at, the trigger, a batch, the notice and its link, refused requests, the command and the row. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `takeMeThere` | `({ thing, waiting, screens, own_origins?, beside?, name?, category?, say?, steps?, key?, fallback_points_at? }) -> { taken: false, said } or { taken: true, screen: { tool_id, route_input }, arrangement, tour, notice, open, said }` | The one decision. `tour` and `notice` are null when no `steps` or no `say.title` is given. |
| arrangement | `{ id, held, replaces, name, category, root }` | `root` is a pane, or a split of the pane and `beside`. |
| tour | `{ id, category, title, steps, triggers }` | Asked for by name; consumed when the card's ids (every row of a batch) are completed. |
| notice | `{ title, body, kind, refs: { open, card }, key }` | `open` is the address that opens the arrangement and walkthrough on any device. |

## Dependencies

**Depends on:** Node 24 only.

**Depended on by:** `tool-rows.json`; the workflows that name `tool:take-me-there` (`file-what-needs-the-person`, `lead-me-to-it`).
