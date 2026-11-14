# processes/lib/

Shared pure helpers that the process scripts in the parent folder import, each mounted beside its consumer at `lib/<name>.mjs` by the action's manifest entry.

A file lives here when two or more process scripts need the same logic. A relative import from a mounted process DOES resolve: `materialize_input_create_only` (`architect/crates/process-engine/src/native_process.rs:557`) creates every component of a `mount_path` except the last, so a declared mount of `lib/carrier.mjs` produces a real `lib/` directory in the job root. Adding a shared file costs three DATA additions in `things-to-store-and-run.json`: one `stored_bytes` entry, one read step, one mount.

## Files

| File | Purpose |
|---|---|
| `carrier.mjs` | The one carrier-address and partition resolution chain. |
| `reply-route.mjs` | The one answer to who gets messaged and on what channel. Names no channel. |
| `template.mjs` | The one payload-template substitution primitive (`$field` to `item[field]`). |
| `artifact-store.mjs` | Content-addressed artifact refs and blob writes, so decision text is stored once by hash. |
| `retention-policy.mjs` | Retention class vocabulary and per-kind policy lookup. |
| `retention-enforcement.mjs` | Pure selection of which addresses a retention pass should retract. |
| `template.test.mjs` | Tests for `template.mjs`. |
| `artifact-store.test.mjs` | Tests for `artifact-store.mjs`. |
| `retention-policy.schema.test.mjs` | Tests for the retention policy shape. |
| `retention-enforcement.test.mjs` | Tests for the retraction selection. |

## Key Functions

| Export | Signature | Role |
|---|---|---|
| `resolveCarrier` | `(env?, options?) => string \| null` | The address of the running engine, by precedence. |
| `resolvePartition` | `(env?) => string \| null` | Which partition to name on a request, or null to let the engine use the app's own. |
| `currentAddressFromFile` | `(env?, options?) => string \| null` | Reads the address out of the file the runtime publishes it into. |
| `CARRIER_AND_PARTITION_REQUIRED` | `string` | The one diagnostic naming every input that can supply these. |
| `fillTemplate` | `(template, item) => object \| null` | Recursive `$field` substitution; `$$` escapes a literal `$`. |
| `buildPayloadFromTemplate` | alias of `fillTemplate` | Back-compat name used by existing importers and tests. |
| `artifactHash` | `(text) => string` | Content hash used as the artifact identity. |
| `artifactStoreAddress` | `(hash) => string` | Address a stored artifact lives at. |
| `buildArtifactRef` | `(text, sourceRef) => object` | Small ref plus bounded preview that a record carries instead of the full text. |
| `buildArtifactBlobWrite` | `(text, sourceRef, partitionLabel) => object` | The write that stores the full text once, batched with its referencing record. |
| `refMatchesText` | `(ref, text) => boolean` | Whether a ref describes this exact text. |
| `extractResolvedArtifact` | `(payload) => string \| null` | Pulls the full text back out of a resolved read. |
| `ARTIFACT_STORE_PREFIX` / `ARTIFACT_STORE_INDEX` / `PREVIEW_CHARS` | constants | Address prefix, index name, preview length. |
| `addressesToRetract` | `(records, policy, nowMs) => string[]` | Which addresses a retention pass should retract. |
| `extractWriteTimeMs` | `(record) => number \| null` | Write time from a record, for age comparisons. |
| `misclassifiedHistoryKinds` | `(records, policy) => string[]` | Kinds stored as history that the policy does not classify. |
| `validateRetentionPolicy` | `(policy) => string[]` | Problems with a policy document, empty when valid. |
| `retentionForKind` | `(policy, kind) => object` | The retention class and window for one record kind. |
| `RETENTION_CLASSES` / `DEFAULT_CLASS` | constants | The class vocabulary and its default. |

## Dependencies

**Depends on:** node builtins only (`node:fs`, `node:crypto`). Nothing here imports another package, reads DATA, or performs I/O beyond `carrier.mjs` reading the published-address file.

**Depended on by:** the process scripts in `../` that declare the matching mount. Currently `carrier.mjs` is mounted by ten actions, `reply-route.mjs` by three (`send-reply`, `send-poll`, `reply-poll`; `surface-human-work-once` was the fourth until it was deleted on 2026-09-04), `template.mjs` by three, `artifact-store.mjs` by one.

`reply-route.mjs` exists because those four each grew their own copy of the same two rules on the same day, which is how a rule ends up diverging four ways. It is pure and exported so `../reply-route.test.mjs` can pin it without an engine; that suite was checked by reintroducing the old hardcoded channel default and confirming 8 assertions fail, rather than by trusting a first green run.

## Invariants

- Every file here stays free of package or domain vocabulary. A helper that names a queue, a channel, or a record kind belongs in the process that owns it, not here.
- A file added here is not reachable until its mount is declared. Three DATA additions, no code change.
- `resolvePartition` returning null is a legal answer, not a failure: the partition is an override and the engine falls back to the app's own.
