# notice-when-something-shows-up/tests

Hostile proof for the resident emitter and its leaves, driven through a fake carrier so no test opens a socket, a volume, or a process. Run with `node --test <absolute path>/emit-arrival-fact.test.mjs`.

## Files

| File | Purpose |
|---|---|
| `emit-arrival-fact.test.mjs` | The capability ledger's proofs, in order: clock parity byte for byte against the predecessor's live record (frozen text, so it survives the predecessor's deletion) and sequence continuity from its counter; an appearance nobody declared is a fact with empty `matched_source_refs`, not an error; departure emits and time never moves backward; two volumes sharing a visible name are told apart by filesystem identity and a name predicate is refused; the emitter source and every waiter row name no workflow target, definition, or action; a refused row and a mechanism that cannot wait each become a fact while the other waiters keep running; a leaf that shadows an arrival field or escapes the folder is refused; the real leaves answer to the manifest's capability references; the volume leaf reports the present set on start and parses identity off the identity file; a forbidden listing is an error, an absent place is an empty answer; the handover and flooring rules. |

## Dependencies

**Depends on:** `../do-work/emit-arrival-fact.mjs`, `../do-work/mechanisms/*.mjs`, `../things-to-store-and-run.json` (waiter rows are read off the manifest, never redeclared here), `node:test`, `node:assert/strict`.
**Depended on by:** nothing at runtime.
