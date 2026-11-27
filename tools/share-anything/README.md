# tools/share-anything/

The one sharing tool: share anything of the person's, read-only, from one record or one piece of text to a whole list or any mix of records, with a named person, an AI, or anyone holding a link; let named people and AIs run some of the person's tools at the person's own door; show who has access; and stop it. One row, `tool:share-anything`, with four ops: `share`, `stop`, `access` and `end` (a run share's end rule).

The tool is a function of its input (rule a-tool-is-only-what-the-store-cannot-do). It makes the keys (each person, AI or link gets one of its own, answered once, and only its BLAKE3 is kept), works out what a share names and who has it, and judges a run share's end rule. It reaches no database and no records door: the caller reads what the share needs from the person's own store, passes it in as `stored`, and writes back the `writes` the answer lists, each only while the store still holds its `expect`. The store is spoken to in its own language (SQL, a folder, a document store); the tool never names one.

A share is one record at `sharing:<label>` in the sharer's own store: `{ reach: [{ type, id? | prefix? }], title, can: ["view"], people: [{ principal, key_blake3, added_at }], published, revoked_at, expires_at, changed_at }`. The engine (trillion-rust `src/account_rights/share_grant.rs`, the reach shape) reads exactly the reach of a record that names the presenter's digest, on every read. No key is kept in any store, so a share needs only the sharer's signed-in session.

## Files

| File | Purpose |
|------|---------|
| `do-work/share-anything.mjs` | `shareAnything(input)`: the one export the row runs (through `do-work/run-a-function.mjs`); `share`, `stop`, `access` and `end` (a run share's end rule). Pure: returns the answer and its `writes` |
| `do-work/end-shares-whose-condition-failed.mjs` | `endSharesWhoseConditionFailed(input)`: judges the run shares the caller lists (`runs`) against their end rules and last uses, and returns the withdrawals as writes; `endOf`, when a rule ends its share |
| `read-data/share-label.mjs` | `labelOf`, `grantOf`, `reachOf`: the one rule for the label a thing is shared at, so a caller can name the label before the run; public (`part.json`) |
| `read-data/share-anything.json` | DATA: the record prefix, the key prefix and size, the kinds, the bounds and every word the tool says |
| `what-this-tool-does-and-how-to-run-it.json` | The rows `tool:share-anything` and `tool:end-shares-whose-condition-failed`: function rows with a sample run each; no records door, no records rights |
| `ports/share-anything.json` | The port contract: no older owner does this job; the nearest are named |
| `kits/share-anything.json`, `kits/end-shares-whose-condition-failed.json` | The plain steps a person's AI follows: what the caller reads, what it writes back, and the examples |
| `test/share-anything.test.mjs` | The tool over a Map store: a list shared with a person, an AI and a link, a text, a collection, stop, access, end, the run shares, what is refused, and the row's shape |
| `test/end-shares-whose-condition-failed.test.mjs` | The sweep over runs the caller lists: no rule, until, unused_days with a last use, op end, unjudged shares, and the row's shape |
| `test/store-round-trip.test.mjs` | One scenario run on a Map, on PGlite (in memory) and on a JSON folder: the same answers, no key kept in any of them, and a stale write refused on PGlite |
| `test/caller-store.mjs` | The caller's side in the tests: the three stores, `applyWrites` (compare-and-set on `expect`), `callTool` and `callSweep` |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `thing` | `{ type, id }` \| `{ list }` \| `{ text, title? }` \| `{ items: [{ type, id? \| prefix? }], title }` | What is shared. A list reaches its definition and every row of its row kind (the definition comes in as `stored.list`); a text is kept as a `shared-text` write first; an item with neither id nor prefix is every record of that type |
| `stored` | `{ kept, list? }` | What the caller read from its store: `kept` the value at `grant` (a share record, or a run grant as listed), `list` the list definition when sharing a list. Null when the store holds nothing |
| `grant` | `sharing:` + `labelOf(thing)` | The one workspace label the run is granted; the tool refuses any other |
| `share` | `{ op, grant, thing?, with?, link?, can?, until?, origin?, title?, stored? }` → `{ op, label, grant, title, reach, people: [{ principal, key, url? }], link?, expires_at, said, writes }` | Each key is answered once and never written. `url` is `origin/share/<key>` when `origin` is given |
| `stop` | `{ op, grant, principal?, stored? }` → `{ op, label, grant, removed, revoked_at?, said, writes }` | A person or `link`, or everyone when `principal` is left out |
| `access` | `{ op, grant, stored? }` → `{ op, label, grant, shared, state, title, reach, people, link, expires_at, said }` | `state` is `open`, `stopped` or `ended`; never a key; no writes |
| `writes` | `[{ kind, address, value, expect, type? }]` | `kind` is `share`, `run-share` or `shared-text`. `value` null withdraws the record at `address`. `expect` is what the store must still hold (null: nothing). A `shared-text` write has no `expect` (its id is the BLAKE3 of its text) |

## How a run goes

- The row grants nothing. The caller reads `stored` (the store's value at `grant`, and `list:<id>` for a list) and writes each item of `writes` in order, only while the store still holds its `expect`. A changed store refuses the write and the caller runs the tool again; keys made by the refused run were never shown, so nothing leaks.
- A share is one record. Sharing with someone already named is refused; stop them first to give a new key. A view share only lets people view; `until` is a future time, and the engine decides again on every read.
- A run share (`can: ["run"]`, `tools`, `with`, optional `until`, `identity`, `journal`) lets named people and AIs run the tools it names at the sharer's own door, with no copy on their computer. Its grant is `{grant: {tools, identity, journal}, people: [{principal, key_blake3}], ends?}` written as a `run-share` item. How long it lasts is the person's choice, and by default it has no end: `until` (a future ISO time) and/or `unused_days` (whole days with no use) is kept as `ends` (`{until?, unused_days?, since}`) beside the grant; the engine reads none of it. `op: "end"` sets the rule again, keeping the people and their keys.
- `endSharesWhoseConditionFailed` takes the run shares the caller lists (`runs`, each with its label, its grant as stored and its last use as the engine lists it) and returns a `run-share` withdrawal (value null) for each whose rule says it has ended. A share with no rule never ends here; a share listed with no last use is judged by `until` alone and counted as unjudged.
- A sealed (device-only) record is not shared by this tool: the engine cannot read it, by design.

## Not yet

- Run shares: the engine still reads the run grant through its own keep and list operations (`sharing.keep`, `sharing.list` at the sharer's own door, trillion-rust `src/account_rights/share-grant.json`). This tool now returns the run grant as a write for the caller to keep where the person keeps it; until the engine reads that place, a run share made here is not admitted by the engine. The engine lane owns that read.
- The sweep's wake (`check-unused-grants`, every hour) still dispatches the sweep with input `{}`. The sweep now needs the listed `runs` from the caller, so the wake answers nothing ended until a caller that lists the store's run shares and writes the withdrawals is built (a recipe under `tools/workflows/definitions/`, not written in this folder).
- The engine's reach reader and page are built by the engine lane; this tool writes the record they read. A share made before the engine reads the `reach` shape opens nothing.
- A share to an AI that needs the person present goes through the person-present confirmation page; this tool only makes the key.

## Dependencies

**Depends on:** `@noble/hashes` (BLAKE3, through `content-identity`), Node's `crypto`, `tools/workflows/do-work/run-a-function.mjs` (the command the row runs). Nothing else: no records door.

**Depended on by:** `what-this-tool-does-and-how-to-run-it.json`; the sharing sheet and the board share in the Trillion apps, which call `tool:share-anything` and use `read-data/share-label.mjs` to name the label. Those callers must now read `stored` from the store and write back `writes`.

## Public scene capsule

`capsule/`, `render/`, `do-work/`, `show/` and `viewer/` hold the public scene capsule moved byte for byte from bitfield-packages `packages/public-scene-share` (receipt `from-bitfield-packages/public-scene-share/moved-from.json`): freeze a scene into a content-addressed capsule, the two publish gates, share scope pruning, the reader, offline render and the Share button. Not wired yet: it reads and writes through the retired Bitfield runtime. Its proof scripts and two documents that hold a computer path or a person's name were not carried.

## Sharing grants moved from the engine (trillion-rust)

`from-the-engine-repository/` holds the engine's sharing-grant code byte for byte, but for one made-up address in a test (`src/account_rights/share_grant.rs`, `share_grant/reach.rs`, `share_given.rs`, `share_given/tests.rs`, `share-grant.json`, `share-given.json`, 2,943 lines), removed from the engine on Nov 15 2026 because it is not one of the engine's five jobs. Receipt: `from-the-engine-repository/moved-from.json`. Not wired: this tool writes the `sharing:<label>` record the engine read.
