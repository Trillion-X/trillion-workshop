# tools/share-anything/

The one sharing tool: share anything of the person's read-only, from one record or one piece of text to a whole list or any mix of records, with a named person, an AI, or anyone holding a link; show who has access; and stop it. One row, `tool:share-anything`, with three ops: `share`, `stop`, `access`.

A share is one workspace record in the sharer's own account, `sharing:<label>`: `{ reach: [{ type, id? | prefix? }], title, can: ["view"], people: [{ principal, key_blake3, added_at }], published, revoked_at, expires_at, changed_at }`. Each person, AI or link in `people` has a key of its own (`shr_` and 32 random bytes) that this tool makes and answers once; only the key's BLAKE3 is kept. The engine (trillion-rust `src/account_rights/share_grant.rs`, the reach shape) reads exactly the reach of a record that names the presenter's digest, on every read: `GET /share/<key>.json` and `GET /share/<key>` for a person with a browser, and `records:read` and `records:list` at the sharer's door for an AI. No key is kept in the sharer's vault, so a share needs only the sharer's signed-in session.

It replaces `tool:share-a-record-by-a-sealed-link` (deleted with this change) and the board capsule's link (the sheet and the board share through this tool).

## Files

| File | Purpose |
|------|---------|
| `do-work/share-anything.mjs` | `shareAnything(input, { door })`: the one export the row runs; `share`, `stop` and `access` |
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
- A share only lets people view. `until` is a future time; the engine decides again on every read, so an ended or stopped share refuses the next read.
- A sealed (device-only) record is not shared by this tool: the engine cannot read it, by design.

## Not yet

- The engine's reach reader and page are built by the engine lane; this tool writes the record they read. A share made before the engine reads the `reach` shape opens nothing.
- A share to an AI that needs the person present goes through the person-present confirmation page; this tool only makes the key.

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`, `writeWorkspace`, `readWorkspace`, `read`, `write`), `@noble/hashes` (BLAKE3), Node's `crypto`.

**Depended on by:** `tool-rows.json`; the sharing sheet and the board share in the Trillion apps, which call `tool:share-anything` and use `read-data/share-label.mjs` to name the label.
