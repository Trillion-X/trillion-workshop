# Documents Do Work

Boundary helpers for Runtime Kit targets used by documents.

`write-authored-scene-content.ts` writes guarded batches to
`package::documents::authored-scene-content` and advances local
basis only after the log accepts the write. `build-composition-action-record.ts`
creates generic action references; execution stays with workflow, owner-action,
and process-session owners.
