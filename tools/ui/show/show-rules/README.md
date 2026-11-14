# parts/ui/show/show-rules

The one question every surface asks before it shows something ("how does this thing show now?"), the menu that silences or hides things like it, and the list of every control the parts declare.

## Files

| File | Purpose |
|------|---------|
| `show-of.ts` | The page's one show-rules answerer seam: a surface passes its subject and its own fields and draws the answer; `controlShown(path)` asks about a declared control with `within` (the path and every path it sits in). With no answerer installed everything shows. |
| `ShowRuleMenu.tsx` | The small menu on any shown thing (a notice, a tour card, a layout row): its heading, the quick choices the app's DATA offers, and each rule holding it now, offered back to turn off. |
| `declared-controls.mjs` | Every control the parts declare in their part.json `controls` plus each open choice (`open.<id>`), as `{ id, label, parent? }` rows; `parent` is the nearest declared path a control sits in, so the list is a tree. The person store hands it out as `controls` (src/show-rules-store.mjs), and the rules screen offers it for the `control` and `within` facts. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `ShowAnswer` | `{ hidden, silenced, until, rules, changes? }` | How a thing shows now. |
| `ShowAnswerer` | `{ ready, showOf, menu, choose, remove, changed, save, shownFromMap? }` | What the app installs (src/workspace/show-rules-live.ts). `shownFromMap` answers a control from the one map every control was decided into when the rules last changed. |
| `showOf` | `(subject, thing) => ShowAnswer` | The one question. |
| `controlShown` | `(control: string, facts?) => boolean` | Whether a declared control is drawn now (subject `control`): a lookup in the answerer's map, no store read and no engine call. Only a control asked with a fact a rule in force reads is decided on its own. |
| `controlWithin` | `(control: string) => string[]` | `a.b.c` → `['a', 'a.b', 'a.b.c']`. |
| `CONTROL_SUBJECT` | `'control'` | The subject every control is decided under. |
| `answerShowWith` / `announceShowChange` / `onShowChange` / `useShowChange` | install, announce, listen, re-render | Answers change when a rule is saved or a moment a rule names passes. |
| `showReady` / `showChanged` / `saveShowRule` / `showMenu` / `chooseShow` / `removeShowRule` | see show-of.ts | Readiness, changed things, rules made on the thing, quick choices. |
| `ShowRuleMenu` | `({ subject, thing, label, className })` | The per-thing menu. |
| `DECLARED_CONTROLS` | `readonly { id: string; label: string; parent?: string }[]` | Every declared control, in declaration order. |

## Dependencies

**Depends on:** React; the part manifests `parts/sidebar/part.json`, `parts/screen-arrangement/part.json`, `parts/command-palette/part.json`, `parts/ui/part.json`; `../placeable-surface-intent/open-choices.json`.

**Depended on by:** every surface that draws a declared control (sidebar, screen arrangement, record views, responses, comments, sharing, Find anything, the tray, automations); `src/workspace/show-rules-live.ts` (installs the answerer); `src/show-rules-store.mjs` (`controls` in its read); `test/show-types-and-controls.test.mjs` and `test/show-controls-consulted.test.mjs`.

## Invariants

- Nothing here names a subject, a fact, an effect or a control; the manifests and the caller say them.
- Asking a control costs a map lookup: the person's rules are read once per session and on their record's change notice, and evaluated once per change in one pass (src/workspace/show-rules-map.mjs). `test/show-rules-one-read.test.mjs` counts it: 1 store request and 1 records read for opening and 50 controls, for 5 rules and for 500.
- A manifest that declares controls and is not read by `declared-controls.mjs` fails `test/show-types-and-controls.test.mjs`.
- A declared control nothing consults fails `test/show-controls-consulted.test.mjs`.
