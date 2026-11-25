# notice-when-something-shows-up/tests

Hostile proof for the resident emitter and its leaves, driven through a fake carrier so no test opens a socket, a volume, or a process. Run with `node --test <absolute path>/emit-arrival-fact.test.mjs`.

## Files

| File | Purpose |
|---|---|
| `emit-arrival-fact.test.mjs` | The capability ledger's proofs, in order: clock parity byte for byte against the predecessor's live record (frozen text, so it survives the predecessor's deletion) and sequence continuity from its counter; an appearance nobody declared is a fact with empty `matched_source_refs`, not an error; departure emits and time never moves backward; two volumes sharing a visible name are told apart by filesystem identity and a name predicate is refused; the emitter source and every waiter row name no workflow target, definition, or action; a refused row and a mechanism that cannot wait each become a fact while the other waiters keep running; a leaf that shadows an arrival field or escapes the folder is refused; the real leaves answer to the manifest's capability references; the volume leaf reports the present set on start and parses identity off the identity file; a forbidden listing is an error, an absent place is an empty answer; the handover and flooring rules. |

| `kept-places-travel.test.mjs` | A waiter's place travels with its wake when the run names `places_in`: two computers (two kept folders and wake books) over one PGlite database of places; a row-changes waiter over a real change table and a service-lists waiter over a stand-in service are moved between them and every change is told exactly once, the target's stale kept-folder place passed over; a database place wins over a folder place, which is carried in once; two runs at once: the later one holds the place and the other is refused, says so, tells nothing more and ends with a refusal fact; a place store that cannot be read is a crash; with no `places_in` the kept folder is used as before; the places table is made once and one with a trigger is refused; the row mounts `places_in` on its own descriptor. |

## Dependencies

**Depends on:** `../do-work/emit-arrival-fact.mjs`, `../do-work/kept-places.mjs`, `@electric-sql/pglite`, `../do-work/mechanisms/*.mjs`, `../things-to-store-and-run.json` (waiter rows are read off the manifest, never redeclared here), `node:test`, `node:assert/strict`.
**Depended on by:** nothing at runtime.
