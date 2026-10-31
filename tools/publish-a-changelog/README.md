# tools/publish-a-changelog/

Keeps the finished work a person is getting ready to publish as a changelog: which group each piece is in, what can be done with it, what stops it (a missing proof, for one) and what was already sent. Two Workshop tools, both run in the tool container. Ported from the changelog-publisher package's queue reader and step writer. The package's own words and rules ("Changelog draft", "Add proof before publishing") were data in its descriptor file; this folder carries none of them, so the person's queue, groups and rules come with each request. Its screens and the requests it sent to the old runtime (a workflow target request and an engine write-batch item) were not brought in. Posting what is ready is the job of `tools/social-posts` and whatever tool the action names.

## Files

| File | Purpose |
|------|---------|
| `read-data/read-record-action-projection.ts` | The reader, unchanged: a queue as data plus records and receipts in, groups, the selected record's actions, blockers and receipts, and a status out. |
| `do-work/record-action-steps.ts` | `buildRecordStep` and `materializeRecordActionGraph`: a step becomes an operation or, when its action names an owner, a handoff with bound inputs; operations fold into records and receipts that are only added to. |
| `do-work/see-what-is-ready.mjs` | `tool:see-what-work-is-ready-to-publish`. |
| `do-work/record-a-step.mjs` | `tool:record-a-publishing-step`. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder. |
| `test/see-what-is-ready.test.mjs` | The reader's cases on a made-up bakery queue. |
| `test/record-a-step.test.mjs` | Steps, handoffs, refusals and the fold. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `readRecordActionProjection` | `({ graph, recordAtoms, receiptAtoms, selectedRecordId, status, issues }) -> model` | The queue laid out; status is empty, sparse, dense, loading, error or blocked, and the density line is the selected view's `density_threshold`. |
| `buildRecordStep` | `(context) -> { recordOperations, handoffs, errors, trace }` | One step. Errors are `missing-operation`, `missing-descriptor`, `unknown-method`. |
| `materializeRecordActionGraph` | `(graph, operations) -> graph` | Folds operations in. The old fold also wrote a `state` into the graph from a fixed count of 12; that was a second source of the status, so it is gone and the reader works it out. |

## Dependencies

**Depends on:** nothing (Node 24 in the tool container runs the `.ts` files by stripping their types).

**Depended on by:** `tool-rows.json`, Trillion's deploy (it bundles the files a row names).
