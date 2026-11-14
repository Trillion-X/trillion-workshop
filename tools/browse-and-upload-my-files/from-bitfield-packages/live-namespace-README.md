# live-namespace

Locator records that let `/cas/<hash>` serve bytes whose custody is somewhere other than the local CAS log: a device file, an HTTP origin, or a peer. The package is DATA only. The resolver is one blind fallthrough in `architect/crates/background-runner` (`write_cas_read_responses`, CAS-miss arm) that reads the locator at the identity-text address `live-namespace::locator::<hash>` and invokes whatever target the row names. The target is resolved through the runner's native handler table first and the installed slot registry second, so `local.files` (native) and `http-client` (an installed slot that speaks HTTP as DATA; this named `network-engine` until 2026-09-05, a crate that never compiled as a slot and is retired) are equally nameable. Bytes on another machine are one row here, not new engine code. A derived representation is not a resolver concept: it is ordinary materialized bytes that this package reaches by the same locator row as any other file, with its source/recipe provenance owned by the existing media relation and workflow owners.

This folder is package implementation source material. Runtime truth comes from the selected Bitfield root's log-owned package state after admission, not from this source folder by itself.

## Files

| File | Purpose |
|---|---|
| `things-to-store-and-run.json` | The `live-namespace.locator`, `live-namespace.name`, `live-namespace.receiver-materialization-fact`, `live-namespace.capability-edge`, and `live-namespace.operation-pair-case` record contracts. A fresh install ships zero locator rows: a locator exists only after an authorized discovery or handover supplies its identity, byte length, and file reference. It also carries six workflow-facing capability edges, the nine executable T12.8 operation-pair rows, the two deferred migration/retirement rows, and the generic locator verification actions plus their DATA trigger. |
| `README.md` | This file. |
| `do-work/verify-live-namespace-data.test.mjs` | Hostile package-local proof that fresh package DATA has no active machine locator or mounted-volume literal, locators are created only from caller-provided handover input, the range action uses the exact T10 operation and checksum command, every pass-record edge is gated, the whole-locator action is a bounded serial loop, the trigger maps only useful locator changes, and `/usr/bin/shasum` fails closed on altered bytes or checksums. |
| `read-data/namespace-records-from-a-name-and-identity-table.mjs` | Pure record shaping. Turns rows pairing a NAME with a CONTENT IDENTITY and a STORED PATH into locator and name records, one group of rows at a time. Owns address rendering, path cleanup, the older-address list, and fail-closed rejection. Reaches no network and opens no file. |
| `read-data/materialization-facts-from-verified-pages.mjs` | Pure admission of verified receiver pages. Owns complete cursor-chain proof, stale subject/state rejection, exact-interval digest-conflict refusal, no-clamping verification, and separation of observation authority from transfer authority. Emits only exact digest-bound possession facts; it is not a cache, scheduler, source adapter, or network client. |
| `read-data/capability-edges.mjs` | Pure admission of workflow-facing capability-edge DATA. Names prerequisites, exact outputs, authority, identical-snapshot measurement obligations, per-dispatch budgets, and type-compatible fail-closed fallbacks. Immutable-byte optimizations retain the direct exact fallback; exact-result edges fall back only to the same declared observable. Dispatches nothing. |
| `read-data/operation-pair-cases.mjs` | Pure operation-pair census compiler. Normalizes nine executable T12.8 rows into five hostile schedules each and keeps migration/reclaim rows explicitly deferred. It validates exact predicates and safe denied/conflict/unavailable outcomes, names only existing executable owners, rejects `payload: null`, and dispatches nothing. |
| `read-data/identical-snapshot-ab-plan.mjs` | Pure normalizer for six-alternative identical-snapshot A/B candidate records. Owns snapshot identity, subject-track separation, cold setup, payload and metadata bytes, CPU, RSS, page cache, origin/relay-peer/receiver network cuts, wall p50/p95/p99, cancellation/retry/deadline/failed-proof accounting, and exact equality. It dispatches nothing and always reserves `execution_admitted` for external review. |
| `do-work/publish-namespace-records.mjs` | Streams those records into one running app's live log in bounded groups, ordered locators-then-names, resumable by row. Owns the second pass that takes back a superseded addressing, and the guard that stops a take-back from unnaming a file the same run published. |
| `do-work/run-publish-namespace-records.mjs` | The front door. Streams lines off disk, measures each distinct identity's bytes, composes transport from `send-requests-to-an-engine`, and reports rows, records, rejections, files not on disk, and peak resident memory. |
| `tests/namespace-records-from-a-name-and-identity-table.test.mjs` | Hostile proof of the renderings where a mistake is SILENT and TOTAL. Four of its tests exist because that exact failure already happened against the real 95,047-file corpus. |
| `tests/materialization-facts-from-verified-pages.test.mjs` | Hostile proof that paging is a complete cursor chain, stale roots fail, one exact interval cannot carry two digests, partial/outside intervals cannot inherit a digest by clamping, observation authority never becomes transfer authority, semantic proxies are refused, and inputs are not mutated. |
| `tests/capability-edges.test.mjs` | Hostile proof that exact result edges cannot use immutable-byte fallbacks, optimized edges carry complete per-dispatch budgets, authority cannot contradict itself, provider/secret/recipe leakage is refused, and normalization never mutates DATA. |
| `tests/operation-pair-cases.test.mjs` | Hostile proof that the T12.8 census stays bounded, nine executable rows become 45 schedule cases, two migration/reclaim rows remain deferred, denied/conflict/unavailable outcomes carry exact predicates, source/provider/semantic-merge leakage fails closed, and malformed or prototype-shaped DATA cannot execute. |
| `tests/identical-snapshot-ab-plan.test.mjs` | Hostile proof that divergent snapshots, incompatible subjects, semantic substitutions, missing network cuts, non-finite counters, malformed arrays, cancellation/equality failures, and self-declared authority cannot become a measurement-complete A/B candidate. |

## Record shape

| Field | Role |
|---|---|
| `kind` | `live-namespace.locator` |
| `target` | Name of anything that answers an envelope: a native target route or an installed slot. Opaque to the resolver. |
| `request` | JSON object the target understands. Opaque to the resolver. |
| `range_keys` | For a source that takes the window as NUMBERS: `{offset, length}` key names the resolver injects at the top level of `request`. |
| `range_render` | For a source that takes the window as ONE FORMATTED VALUE: `{target_path, template}`. The resolver renders `template` and writes it at the explicit key path `target_path`. Substitution set is exactly `{offset}`, `{length}`, `{end_inclusive}`; an unrecognized name is left verbatim. Example: `{"target_path": ["headers", "Range"], "template": "bytes={offset}-{end_inclusive}"}` reads an HTTP origin without the resolver knowing HTTP exists. |
| `response_bytes_pointer` | RFC 6901 pointer to the encoded bytes in the target's JSON reply. Empty when the reply payload IS the bytes. |
| `response_encoding` | `base64` (decode the string at the pointer) or `payload-is-the-bytes` (the reply payload IS the range, so nothing is parsed or decoded). Declaring both an encoding of `payload-is-the-bytes` and a pointer is refused. |
| `byte_length` | Total representation length; the `Content-Range` denominator. |
| `verification` | Optional non-empty offline samples: `[{offset,length,sha256}]`. Each window is at most 16 MiB and lies wholly inside `byte_length`. This is DATA for the generic verification actions, never a hot-path read check. |
| `identity_grade`, `attestation`, `priority`, `available`, `pin`, `durability`, `last_verified_at` | Optional facts for evidence-graded identity, source selection, pinning, and the durability ladder. `durability` must be a member of `durability_vocabulary` on the locator contract row (`local-only`, `replicating`, `durable-at-origin`, `multi-domain`, `conflicted`, `unavailable`, `verified`); it is observed per-copy state and never origin policy, which `cloud-files` owns. Not consulted by the resolver this cycle. |

## `live-namespace.name` (one naming fact)

| Field | Role |
|---|---|
| `kind` | `live-namespace.name` |
| `name` | What this thing is called, in its collection. |
| `identity` | The exact multihash text a `/cas/<hash>` request carries. **Absent means this name is a COLLECTION**: a place, not bytes. |
| `byte_length`, `modified_at_ms` | Optional. `byte_length` is safe beside a CONTENT-addressed identity, where the length is an immutable property of immutable bytes and cannot drift from the locator that also states it. Beside an attested identity the locator row is authoritative. |

Address: `live-namespace::name::<absolute path of the entry>`, e.g. `live-namespace::name::/expansion/33/00/master.mov`. **One name, one address, so resolving a single name is one read and never a scan.** Making a lookup scan its collection cost 23.76 s for one `ffprobe` of a 54 GB file where a direct read cost 0.716 s, because a media player issues dozens of ranged reads and each one re-scanned.

The collection is the record's **PATH**, never a field: `["live-namespace", "name", "<absolute collection path>"]`. The collection is ONE path segment holding the whole slash-joined path, **not one segment per level**, because a path-prefix scan returns a SUBTREE. Per-level segments would make listing a shallow collection cost its entire descendant tree, and listing the root cost everything. One segment makes a prefix scan return exactly that collection's immediate children, so a listing costs the size of its answer. The root is `/`, never an empty string.

**There is no `is_collection` flag and none may be added.** A collection is a name with no bytes, which `identity` already says. A separate flag is a second encoding of one fact and makes two contradictions writable: a collection carrying an identity, and a file carrying none.

**Listing a collection is a path scan, not a stored record.** `engine.operation.scan-current-under-path` over these records. There is no derived directory record and nothing to keep in sync, because the engine already indexes current state by path, so the listing IS the query. A scan reply's `next_cursor` is part of the contract: ignoring it silently truncates a folder, and a truncated folder looks exactly like a complete one.

A name and a locator are separate records on purpose. A locator says HOW TO READ BYTES and is addressed by identity; a name says WHAT SOMETHING IS CALLED AND WHERE IT SITS. The same bytes can carry many names, so a name on a locator would break the moment two names point at one blob.

## Populating from a table of names

A drive scan, an export from another store, or a remote index emits rows of `name, identity,
stored path`. `run-publish-namespace-records.mjs` turns those into one locator per DISTINCT
identity and one name per row, and writes them to the live log of a running app. It never writes
into this source folder.

```
node <pkg>/do-work/run-publish-namespace-records.mjs --table <tab-separated file> --name-root <absolute root the names hang from> --engine 127.0.0.1:<port> --scheme http --partition <label>
```

One line, because a shell continuation reads as a separate command to the run guard. The port
ROTATES on every restart; read it rather than reusing a number. Optional: `--name-column`,
`--identity-column`, `--stored-path-column`, `--batch-size`, `--start-row`, `--max-rows`,
`--kinds`, `--dry-run`.

**Sizes are not optional.** The mount reports `getcontentlength: byte_length.unwrap_or(0)`, so a
name published without one shows in Finder as an empty file and Premiere refuses to open it. The
front door measures each distinct identity once and records `available` from whether the bytes
were actually there, rather than asserting `true`.

**Memory stays flat while the corpus grows.** Lines are read one at a time, records are built one
group at a time, and each group is forgotten once written. The only thing that scales with the
corpus is the set of identities already written, which holds identities rather than records and
is what stops one locator being written once per name. This is not a nicety: the job is every
file a person owns, on a namespace meant to be given away.

## Correcting an address that was already published

Republishing at a corrected address only puts the right record NEXT TO the wrong one. The old
address must be taken back, so a correction is two acts:

```
--older-way-names-became-addresses <key> --older-name-root <the root that was used before>
```

The older ways live in `OLDER_WAYS_A_NAME_BECAME_AN_ADDRESS` in the read-data module, keyed by
WHAT THE OLD WAY DID, never by the mistake that retired it.
Take-back runs as a SECOND pass over the whole table, because a retraction landing on an address
the same run published would unname a file and would win by going last; that check needs every
name the run publishes. A retraction OMITS `payload` entirely. `payload: null` writes the four
bytes `null`, leaving the address in the index and in the reclaim reachable set, which is a
tombstone wearing a retraction's clothes.

## Adding a source

Publish one locator row. No code changes anywhere. The same file may be published under an attested identity hash and, later, under its content hash; both rows resolve to the same bytes.

## Verifying a locator

`action:verify-locator-range` reads one bounded window through `engine.operation.read-cas-range`, mounts only the returned `bytes_base64` as `range.bin`, and mounts exactly `<sha256>  range.bin\n` as `expected.sha256`. It invokes `/usr/bin/shasum -a 256 -c expected.sha256` with leaf containment and no outputs, then writes `live-namespace::verification::<hash>:<offset>-<length>` only when all inbound gates pass:

1. the source was found;
2. its `total_len` equals the locator's `byte_length`;
3. `byte_count` equals the requested `length`;
4. the checksum utility exited `0`.

There is no unconditional writer and no failure-record path: a failed verification simply cannot write `status: "pass"`.

**Why each of those three gates reads the path it reads.** Each is one binding edge into
`write_pass_record`, and the choice of source path is the gate:

- **`output.byte_count` from `read_range`.** The structural gate uses only source `StepOutput`, so
  T10 must echo the requested length back rather than the length it happened to return.
- **`output.total_len` from `read_range`.** A sampled-window pass must not bless a locator that
  lies about the WHOLE representation length. Checking only the window would let a locator claim
  any total it liked.
- **`output.termination.code` from `hash_range`.** The checksum gate is the EXIT CODE, never
  parsed stdout. Parsing the utility's text would make the gate depend on its output format.

Those three sentences lived in `_comment` fields on the binding edges themselves until they were
moved here, per the rule `a-record-payload-may-not-carry-a-note-to-the-reader`. A workflow edge has
no name field to carry the reasoning, and a payload ships to the live log where nothing reads it,
so the README is the only home that a reader actually opens.

`action:verify-locator` loops serially over `input.verification`, invokes only `action:verify-locator-range`, and is capped at 256 iterations. `trigger:verify-locator-on-change` dispatches the whole-locator action to `slot::workflow` when a non-retracted `live-namespace::locator::*` payload of kind `live-namespace.locator` carries a non-null, non-empty `verification` array. It derives the identity by removing the locator address prefix and copies `byte_length` plus `verification` from the changed payload; no source, protocol, device, benchmark, or path is named.

## Capability edges

`live-namespace.capability-edge` records are workflow DATA, not a dispatcher or cache. They say which existing owner could execute an alternative, what authority and complete evidence it needs, what exact subject it may output, and how it fails. Six current edges describe direct exact read, missing-range read, receiver-cache read, exact delta reconstruction, existing result read, and remote result compute.

Three boundaries are load-bearing. First, an immutable-byte optimization must retain `direct-exact-read` as its sha256-exact fallback. An exact-result edge is a different subject: it may fall back only to another edge with the same `content-media.relation.record.role_ref` observable, never to original bytes. Second, every optimized edge names all identical-snapshot A/B counters and a workflow-admission budget contract; finite nonnegative per-dispatch upper bounds must exist before work, `execution_admitted` stays false until separate measurement proof exists, and a published local ratio never becomes performance authority. Third, the records embed no provider, credential, recipe, delta, or locator-payload extension; those remain with their existing owners.

## Operation-pair hostile subset

`live-namespace.operation-pair-case` is pure test-shape DATA, not an operation dispatcher. The first wave normalizes census rows P101, P103, P151, P152, P207, P252, P377, P422, and P312 into 45 cases across sequential both orders, concurrent overlap, retry/replay, and injected partition. It keeps safe denial, conflict, and unavailable outcomes as valid hostile results only with exact state/error predicates. P519 and P521 remain explicitly deferred migration/retirement/reclaim rows; engine interleaving itself remains with T12.9 and the named runtime owners.

## Identical-snapshot A/B candidates

`live-namespace.identical-snapshot-ab` is the pure measurement-record boundary for those edges. One record set must name one receiver snapshot and contain direct exact transfer, missing-range, receiver-cache, exact-delta, existing-result, and remote-compute candidates. The normalizer ranks immutable-byte and exact-result candidates only inside their own subject track and requires every counter named in the package contract, including separate payload and metadata bytes and origin, relay/peer, and receiver network cuts. A complete, failure-free, exactly equal set is only `candidateMeasurementAdmitted`; `execution_admitted` remains false and a separate reviewed authority transition owns whether a T12.6 edge may execute.

## Dependencies

**Depends on:** the target each row names (today `local.files`, a native target in `bitfield-runtime-kit/bitfield-runner`; any installed slot is also nameable since architect `fa10a91e`), `background-runner` CAS-miss fallthrough (architect `14a9f005`), `engine.operation.read-cas-range` for offline verification, `compute.process` for the checksum utility, `trigger-engine` + `slot::workflow` for automation, and selection in the Trillion forward package-set DATA (`selected-packages.json`, 89 packages).
**Depended on by:** every `/cas/<hash>` consumer once a locator is published: the shell `/cas` route, `media-playback`, `file-viewer`, and the shell `/namespace` mount face (runtime-kit `95c3d15` + `589e4e2`), which lists a collection by scanning `live-namespace.name` records with `engine.operation.scan-current-under-path`, resolves one name at its own address with `engine.operation.read-current`, and serves bytes through the same `cas_stream_response` the `/cas` route uses.

## Invariants

- The mount face owns a wire format and nothing else. It never enumerates records, never learns a source or package name, and never gets its own byte path: a namespace GET calls the same `cas_stream_response` as `/cas`.
- A mount read is always bounded. `Depth: infinity` is refused with 403 `propfind-finite-depth`, and so is an absent `Depth` header, even though RFC 4918 makes infinity the default.
- The resolver never reads `target` or `request` for meaning. If `"s3"`, `"local-disk"`, or `local.files` appears in resolver code, the design failed.
- A CAS-log hit never consults a locator. A miss with no locator stays NOT_FOUND.
- Exactly one of `range_keys` / `range_render` per row. Neither is refused (the source would be asked for the whole
  representation, the unbounded read this package exists to make impossible); both is refused (two spellings can disagree).
- The resolver owns the QUANTITIES a byte range has. It never owns how a protocol SPELLS them. If `bytes=` or the string
  `Range` appears in resolver code, the design failed the same way naming `s3` would.
- A source that returns the wrong byte count for a clamped range fails closed.
- A target that is neither a registered native target nor an installed slot fails closed with an INTERNAL frame. It never degrades to NOT_FOUND or an empty read.
- No read materializes a whole representation. Bytes are streamed one bounded window at a time, so a 54 GB source costs the same memory as a 54 KB one. Buffering a whole response is what took the runtime to a 23 GB footprint on 2026-09-03.
