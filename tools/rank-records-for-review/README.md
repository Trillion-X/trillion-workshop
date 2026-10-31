# tools/rank-records-for-review/

Puts a person's records in the order they should review them, with the fields they chose on each row and where they already stand on it (accepted, passed, partly, or nothing yet), and turns an accept or pass into the request that keeps it as their stand. Ported from bitfield-packages `suggested-match`, which was a ranked record review projection; the stand part is new: accept and pass are stands, and the one owner of stands is `tools/where-a-person-stands`.

Every word about a domain is in the descriptor the person gives (fields, filters, relationships, status key paths, actions and their labels). The code knows records, paths, ranks and refs only. Rows come smallest rank first, then by record ref, so the same records always give the same order.

## Files

| File | Purpose |
|------|---------|
| `read-data/rank-records-for-review.mjs` | The pure fold: records, related records, stands and a descriptor in, ranked rows out; the maintained state (create, apply upsert and delete events, snapshot) and the descriptor check. |
| `read-data/example-review-descriptor.json` | An example descriptor with made-up labels for a person to replace with their own. |
| `do-work/rank-records-for-review.mjs` | `tool:rank-records-for-review`: reads the request on standard input, applies events, prints the rows. |
| `do-work/accept-or-pass.mjs` | `tool:accept-or-pass-on-a-ranked-record`: folds the one record, takes the named action, prints the request for `tool:keep-where-you-stand`. Writes nothing. |
| `do-work/stand-request.mjs` | Builds that request: stance from the action, `answered_by` always `person`, copy rules read only the row or the person's input and set only `why`, `by` or `at`, and the row, idempotency and request refs and `unchanged`. |
| `part.json` | The fold and the request builder are public. |
| `tool-rows.json` | The Workshop rows for both tools. |
| `test/rank-records-for-review.test.mjs` | Tests, with made-up records in `test/fixtures/`. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| Descriptor | `{ id, source: {address}, fields: [{id, path, role?, display?}], standKind, standView: {key: path}, recordIdPath?, rankPath?, statusKeyPaths?, filters?, relationships?, actions? }` | Everything about the domain, given by the person. `standKind` is one word without `/`; `standView` names the parts of a record a stand is on. Nothing else is read; a key the fold does not read (such as status labels or colours) belongs to the screen. |
| `foldRankedRecordReviewProjection` | `({descriptor, records, related?, stands?, methods?, cursor?}) -> {projectionId, source, cursor, rows, proof}` | The fold. Rows are smallest `rank` first, then by record ref. A record with no rank (missing, not a number, not finite) has `rank: null` on its row and comes after every ranked row; JSON keeps it as `null`. |
| Row | `{recordId, rank, values, relationships, statusKeys, actions, standKind, standView, stand, standVersion, idempotencyRef?, candidateRecordRefs, sourceRecordRefs, evidenceRefs, ruleRefs, source}` | One record as shown. `stand` is the person's newest stand on the row's view, or `null`: when their newest version takes the stand back (no stance) there is no stand, and an older one in the same history is not revived. |
| Action | `{id, label, stance, enabledWhen?, disabledReason?, copy?}` | `stance` is a stand the keeper keeps (agree, disagree, partly). `copy: [{key, from \| value}]` fills the stand's words: `key` is `why`, `by` or `at` only, because those are the only fields the keeper's input takes besides the thing stood on, the stance and `answered_by`; `from` reads `row.<path>` or `input.<path>`. |
| Filter, relationship method | `field.exists`, `field.equals`, `field.notEquals`, `refs.count` | The method table. A caller may add methods; an unknown method is refused. |
| `createRankedReviewState` / `applyRankedReviewEvents` / `snapshotRankedReviewProjection` | records -> state; state + events -> state; state + descriptor -> the fold | The maintained state: upsert and delete events with cursors. |
| `buildStandRequest` | `(action + {lookup: {row, input?, requestRef?}}) -> {tool, row_ref, idempotency_ref, request_ref, unchanged, input}` | The request for `tool:keep-where-you-stand`. `input` is all the keeper takes. `idempotency_ref` is `<row's idempotency ref, else record ref>:<action id>` plus the words copied (URI-encoded JSON), plus `@<time>` of the newest version of the stand on the row when there is one (even one taken back; a version kept without a time is named `n<place>`, its place in the history, so it still differs), so the same act on the same row as it stands has the same ref and accept, pass, accept again is three refs, not two; `request_ref` is the caller's or that ref; `unchanged` is true when the stand on the row already has this stance and these words. A caller does not run the keeper again for a ref it has run (the ref changes whenever the person's stand does, so a real change is never skipped), or when `unchanged` is true. |

## Not carried

The old package's refresh-request descriptor (a request to the old engine to start a process session), its owner-action workflow targets, its phone-runtime wrapper and its sender callback belonged to the old engine. A refresh is any caller running the tool again with fresh records.

## Dependencies

**Depends on:** Node 24 only. The request it returns is for `tools/where-a-person-stands`; this folder imports nothing from it.

**Depended on by:** `tool-rows.json`.
