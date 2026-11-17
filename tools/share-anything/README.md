# tools/share-anything/

The one sharing tool: share anything of the person's read-only, from one record or one piece of text to a whole list or any mix of records, with a named person, an AI, or anyone holding a link; show who has access; and stop it. One row, `tool:share-anything`, with three ops: `share`, `stop`, `access`.

A share is one workspace record in the sharer's own account, `sharing:<label>`: `{ reach: [{ type, id? | prefix? }], title, can: ["view"], people: [{ principal, key_blake3, added_at }], published, revoked_at, expires_at, changed_at }`. Each person, AI or link in `people` has a key of its own (`shr_` and 32 random bytes) that this tool makes and answers once; only the key's BLAKE3 is kept. The engine (trillion-rust `src/account_rights/share_grant.rs`, the reach shape) reads exactly the reach of a record that names the presenter's digest, on every read: `GET /share/<key>.json` and `GET /share/<key>` for a person with a browser, and `records:read` and `records:list` at the sharer's door for an AI. No key is kept in the sharer's vault, so a share needs only the sharer's signed-in session.

It replaces `tool:share-a-record-by-a-sealed-link` (deleted with this change) and the board capsule's link (the sheet and the board share through this tool).

## Files

| File | Purpose |
|------|---------|
| `do-work/share-anything.mjs` | `shareAnything(input, { door })`: the one export the row runs; `share`, `stop`, `access` and `end` (a run share's end rule) |
| `do-work/end-shares-whose-condition-failed.mjs` | `endSharesWhoseConditionFailed(input, { door })`: the export the sweep row runs; lists every run share with its end rule and last use through the engine's share list and withdraws each whose rule says it has ended; `endOf`, when a rule ends its share |
| `read-data/share-label.mjs` | `labelOf`, `grantOf`, `reachOf`: the one rule for the label a thing is shared at, so a caller can name the label before the run (the row grants that one label); public (`part.json`) |
| `read-data/share-anything.json` | DATA: the record prefix, the key prefix and size, the kinds, the bounds and every word the tool says |
| `tool-rows.json` | The row `tool:share-anything` and a sample run |
| `ports/share-anything.json` | The port contract: no older owner does this job; the nearest are named |
| `test/share-anything.test.mjs` | A stand-in records door holding exactly the row's rights: a list shared with a person, an AI and a link, a text, a collection, stop, access, end, and what is refused |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `thing` | `{ type, id }` \| `{ list }` \| `{ text, title? }` \| `{ items: [{ type, id? \| prefix? }], title }` | What is shared. A list reaches its definition and every row of its row kind; a text is kept as a `shared-text` record first; an item with neither id nor prefix is every record of that type |
| `grant` | `sharing:` + `labelOf(thing)` | The one workspace label the run is granted; the tool refuses any other |
| `share` | `{ op, grant, thing, with?, link?, can?, until?, origin?, title? }` → `{ op, label, grant, title, reach, people: [{ principal, key, url? }], link?: { key, url? }, expires_at, said }` | Each key is answered once. `url` is `origin/share/<key>` when `origin` is given |
| `stop` | `{ op, grant, principal? }` → `{ op, label, grant, removed, revoked_at?, said }` | A person or `link`, or everyone when `principal` is left out |
| `access` | `{ op, grant }` → `{ op, label, grant, shared, state, title, reach, people: [{ principal, kind, added_at }], link: { on, added_at } \| null, expires_at, said }` | `state` is `open`, `stopped` or `ended`; never a key |

## How a run goes

- The row grants the run exactly one workspace label (`grant`), the list definitions it may read (`list:`), and the `shared-text:` records it may write. It is never granted the records it shares: what is shared is the reach it writes, which the engine bounds on every read.
- A share is written, read back, and written again (up to three tries) when another change to the record landed in between. Sharing with someone already named is refused; stop them first to give a new key.
- A view share only lets people view. `until` is a future time; the engine decides again on every read, so an ended or stopped share refuses the next read.
- A run share (`can: ["run"]`, `tools`, `with`, optional `until`, `identity`, `journal`) lets named people and AIs run the tools it names at the sharer's own door, with no copy of the tool on their computer. It is kept by the engine's own keep operation (trillion-rust `src/account_rights/share-grant.json` `act`: `sharing.keep`, `sharing.list` at `@own-records`) in the sharer's vault, the only place the engine reads it from: `{label, party, grant: {tools, identity, journal}, people: [{principal, key_blake3}]}`. A key holder may list and run only those tools; the engine reads the grant again at every call, so a stopped person or a withdrawn grant refuses the next call. How long it lasts is the person's choice, and by default it has no end (the owner, Nov 17 2026): it stands until they stop it. They may give an end rule, `until` (a future time) and/or `unused_days` (whole days with no use, each use starting them again), kept as `ends` (`{until?, unused_days?, since}`, `since` when the rule was set) beside the grant by the same keep; the engine keeps it and reads none of it. `op: "end"` sets the rule again (neither given: no end), keeping the people and their keys; a share to more people or a stop of one keeps the rule the share has. `tool:end-shares-whose-condition-failed` lists every run share with its rule and its last use (`sharing.list` with `{label: "sharing:*"}`, the engine's `last_used`) and withdraws (`sharing.withdraw`) each whose rule says it has ended; a share listed without `last_used` is judged by its `until` alone and counted as unjudged. Its row declares a wake every hour (`run.check_every_ms` of `read-data/share-anything.json`, the grain at which the engine writes a last use), which the sharer switches on with `wake:switch`; the run it starts holds the sharer's rights narrowed to its row, may withdraw or list a grant under `sharing:*` and never keep one. A share kept before this, holding an end the engine no longer reads, is refused at its next call naming that field; share again with the same people and they keep their keys. The row names only the one label `grant` for the keep and the list.
- A sealed (device-only) record is not shared by this tool: the engine cannot read it, by design.

## Not yet

- The engine's reach reader and page are built by the engine lane; this tool writes the record they read. A share made before the engine reads the `reach` shape opens nothing.
- A share to an AI that needs the person present goes through the person-present confirmation page; this tool only makes the key.

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`, `writeWorkspace`, `readWorkspace`, `read`, `write`), `@noble/hashes` (BLAKE3), Node's `crypto`.

**Depended on by:** `tool-rows.json`; the sharing sheet and the board share in the Trillion apps, which call `tool:share-anything` and use `read-data/share-label.mjs` to name the label.

## Public scene capsule

`capsule/`, `render/`, `do-work/`, `show/` and `viewer/` hold the public scene capsule moved byte for byte from bitfield-packages `packages/public-scene-share` (receipt `from-bitfield-packages/public-scene-share/moved-from.json`): freeze a scene into a content-addressed capsule, the two publish gates, share scope pruning, the reader, offline render and the Share button. Not wired yet: it reads and writes through the retired Bitfield runtime. Its proof scripts and two documents that hold a computer path or a person's name were not carried.

## Sharing grants moved from the engine (trillion-rust)

`from-trillion-rust/` holds the engine's sharing-grant code byte for byte, but for one made-up address in a test (`src/account_rights/share_grant.rs`, `share_grant/reach.rs`, `share_given.rs`, `share_given/tests.rs`, `share-grant.json`, `share-given.json`, 2,943 lines), removed from the engine on Nov 15 2026 because it is not one of the engine's five jobs. Receipt: `from-trillion-rust/moved-from.json`. Not wired: this tool writes the `sharing:<label>` record the engine read.
