# tools/work-breakdown/

Holds a body of work as a tree of DATA: rolls up how much is really finished (an item said done with nothing anyone can check never counts), adds requested items with who asked for them, and checks whether the proof behind finished work can be checked. Three Workshop tools: `tool:roll-up-work-completion` and `tool:add-work-item` run in the deployed tool container, `tool:check-proof-of-finished-work` asks a hosted model with the package's rubric. Ported from bitfield-packages `packages/work-breakdown`; nothing here is imported by the Worker.

## Files

| File | Purpose |
|------|---------|
| `do-work/roll-up-work-completion.mjs` | `readTree`, `measure`, `shareFinished`, `renderChecklist`, `rollUpWork`; its command takes `{ tree, as?, only?, depth? }` in `argv[2]` and prints one JSON line. |
| `do-work/intake-work-item.mjs` | `intakeWorkItem(tree, item)`: validates who asked (conversation and message number), deduplicates retries, refines or corrects an existing item; its command takes `{ tree, item }` and prints the tree with the item in it. |
| `records.json` | The three tool rows; the proof check's row carries the package's rubric and calibration examples as its prompt. |
| `part.json` | No public files: only the container runs this code. |
| `tool-rows.json` | Lists `records.json` into the Workshop (`source:business-work-breakdown-tools`). |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| `rollUpWork` | `(tree, { as?: 'json' \| 'checklist', only?, depth? }) => report` | Totals, share finished, said-done-without-proof ids, blocked items and walls, unrouted open ids; or the checklist. |
| `readTree` | `(document) => { document, root, states }` | Refuses a typed-in completion field or an undeclared state. |
| `measure` | `(node, states) => { leaves, finished, claimed, blocked, claimed_without_verification }` | A parent is only the sum of its items. |
| `intakeWorkItem` | `(tree, item) => { tree, changed, item }` | One requested item into the tree. |
| `DEFAULT_STATES` | `{ done, open, blocked }` | Used when a tree declares no states. |

## Invariants

- Completion is derived from item states on every read and never written down; a `done` item without `verified_by` is counted as said done, not finished.
- One conversation message becomes at most one item; replaying it changes nothing.

## Dependencies

**Depends on:** Node 24 in the tool container; the hosted model runtime for the proof check.

**Depended on by:** Trillion's deploy (it reads `tool-rows.json` and bundles the files a row names), the Workshop's executors, Trillion's `test/business-tools.test.mjs`.
