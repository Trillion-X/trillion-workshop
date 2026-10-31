# tools/work-breakdown/

Holds a body of work as a tree of DATA: rolls up how much is really finished (an item said done with nothing anyone can check never counts), adds requested items with who asked for them, checks whether the proof behind finished work can be checked, and reads the facts kept about tasks into one entry per task with what each blocks. Four Workshop tools: `tool:roll-up-work-completion`, `tool:add-work-item` and `tool:list-tasks-and-what-blocks-them` run in the deployed tool container, `tool:check-proof-of-finished-work` asks a hosted model with the package's rubric. Ported from bitfield-packages `packages/work-breakdown` and `packages/tasks` (a task is a work item that carries an assignee, a priority and what blocks it, so it is the same job: one folder); nothing here is imported by the Worker. The tasks package's screens (`show/`) and its old-engine action builder `accept-source-linked-proposal` stay behind.

## Files

| File | Purpose |
|------|---------|
| `do-work/roll-up-work-completion.mjs` | `readTree`, `measure`, `shareFinished`, `renderChecklist`, `rollUpWork`; its command takes `{ tree, as?, only?, depth? }` in `argv[2]` and prints one JSON line. |
| `do-work/intake-work-item.mjs` | `intakeWorkItem(tree, item)`: validates who asked (conversation and message number), deduplicates retries, refines or corrects an existing item; its command takes `{ tree, item }` and prints the tree with the item in it. |
| `do-work/list-tasks-and-what-blocks-them.mjs` | Command: `{ rows }` in `argv[2]` (one row per fact about a task), prints `{ tasks }`. |
| `read-data/read-tasks.ts` | `decodeTasksFeed(rows)`: groups fact rows by subject into task entries and works out what each task blocks. Carried from `packages/tasks`. |
| `read-data/read-task-json.ts` | `parseTaskJsonValue`, `readTaskRecordArray`, `readTaskString`: the text-or-bytes-or-value reader the decoder uses. Carried from `packages/tasks`. |
| `test/` | `roll-up-work-completion.test.mjs`, `intake-work-item.test.mjs` (carried from the package's `tests/`), `read-tasks.test.mjs` (carried from `packages/tasks`, plus the command). |
| `records.json` | The four tool rows; the proof check's row carries the package's rubric and calibration examples as its prompt. |
| `part.json` | No public files: only the container runs this code. |
| `tool-rows.json` | Lists `records.json` into the Workshop (`source:business-work-breakdown-tools`). |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| `rollUpWork` | `(tree, { as?: 'json' \| 'checklist', only?, depth? }) => report` | Totals, share finished, said-done-without-proof ids, blocked items and walls, unrouted open ids; or the checklist. |
| `readTree` | `(document) => { document, root, states }` | Refuses a typed-in completion field or an undeclared state. |
| `measure` | `(node, states) => { leaves, finished, claimed, blocked, claimed_without_verification }` | A parent is only the sum of its items. |
| `intakeWorkItem` | `(tree, item) => { tree, changed, item }` | One requested item into the tree. |
| `decodeTasksFeed` | `(rows) => TaskEntry[]` | Fact rows to one entry per task; `blocks` is the reverse of `blockedBy`, once each. |
| `DEFAULT_STATES` | `{ done, open, blocked }` | Used when a tree declares no states. |

## Invariants

- Completion is derived from item states on every read and never written down; a `done` item without `verified_by` is counted as said done, not finished.
- One conversation message becomes at most one item; replaying it changes nothing.

## Dependencies

**Depends on:** Node 24 in the tool container; the hosted model runtime for the proof check.

**Depended on by:** Trillion's deploy (it reads `tool-rows.json` and bundles the files a row names), the Workshop's executors, Trillion's `test/business-tools.test.mjs`.
