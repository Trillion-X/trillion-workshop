# Visual Database Read Data

This folder contains pure decoding code for the generic visual database.

The decoder accepts arbitrary records plus field/view/action descriptor data. It must not import task, idea, workflow-slot, or owner package types. Domain meaning comes from descriptors and record payload paths.

`projectResolvedFieldValues` attaches current computed values to a read wrapper by field identity. It leaves raw payloads untouched, so unrelated writes cannot save computed values. Missing, stale and failed results suppress raw fallback; the surface admits only results matching the current input generation.

## Files

| File | Purpose |
|------|---------|
| `visual-database.ts` | The bidirectional field contract: descriptor schema v2 decode, value extraction, shape derivation, domain resolution, discovery, filters/search, grouping, memoized tree projection (`treeProjectionForRecords` with `nodeByKey` index), ordering comparator, and the memoized model decode |
| `field-contract.test.ts` | W1 verification fixtures: discovery, descriptor-id filters, shape derivation, kanban-by-anything, preserve-unknown domains, named list-color palette decode, tree cycle/orphan guards, search |
| `tree-projection-scale.test.ts` | Scale + memoization contract: same-identity memo hit, rebuild on identity rotation, `nodeByKey` children correctness, `treeForRecords` read-through contract, 4418-record × 3-pass lookup sweep bounded |

## Key Types / Functions

| Export | Shape / Signature | Role |
|--------|-------------------|------|
| `VisualDatabaseFieldDescriptor` | `{ id, label, role: string, paths, writePath?, shape?, domain?, sortable?, groupable?, filterable?, editable?, emptyLabel?, source? }` | The WHOLE field contract — read paths, write path, value domain, capability flags (all default true), and descriptor source (`declared` or `discovered`). Declared descriptors are UI-placed field data; discovered descriptors are raw observed payload fields for search/filter/detail inspection until a descriptor promotes them. `role` is an OPEN structural-binding string, preserved verbatim |
| `VisualDatabaseFieldDomain` | `{ values?, fromField?, fromAddress?, fromRecords?, open? }` | Domain sources: inline values, distinct observed values of another field, an addressed data record, filtered feed records, plus optional free-typed values |
| `VisualDatabaseFieldDomainValue` / `VisualDatabaseLaneDescriptor` | `{ id, label, tone?: string, color?: string, order }` | One domain value. A lane IS a domain value of the grouping field (one type, one truth). Exact `color` owns visual identity; semantic `tone` owns behavior and supplies one legacy fallback when color is absent |
| `VisualDatabasePaletteColor` | `{ id, label, color, order }` | One human-named list color. Older palettes may still be raw strings; decode normalizes strings and named objects so list colors can be selected, renamed, and extended without a second settings store |
| `VisualDatabaseViewFilter` | `{ field: string, equals, exclude }` | `field` is a descriptor id (or structural-binding name for back-compat); no closed union |
| `VisualDatabaseActionDescriptor` | action descriptor | Field-level or record-level action data; can carry `definitionIds`, generated inputs, and copy rules so one UI action composes existing owner actions |
| `decodeVisualDatabaseModel(input)` | `(DecodeVisualDatabaseInput) → VisualDatabaseModel` | Pure decode, memoized on input identity; merges explicit descriptors with discovered ones; sorts by `compareSortValues` |
| decoded records | plain JSON-like rows | Lazy record-table/source-byte proxies are materialized once at decode; unreadable rows are dropped before fields, trees, filters, or renderers can touch them |
| `extractFieldValue` / `extractFieldText` | `(record, descriptor) → unknown / readonly string[]` | Generic extraction through descriptor read paths; array values yield one text per element |
| `deriveShape(value, descriptor?)` | `→ string` | JSON-physics value shape (`text/longtext/number/flag/choice/multi/temporal/reference/attachments`); descriptor `shape`/`domain` wins; attachment roles become `attachments`; unknown degrades to text |
| `readAttachmentRefs(value)` | `→ AttachmentRef[]` | Normalizes string/object attachment values without losing raw data: file paths, URLs, log/address refs, content/CAS refs, inline preview content, and source labels ride one generic shape |
| `effectiveDomain(descriptor, model, view?)` | `→ DomainValue[]` | Declared domain + every observed-but-undeclared value preserved as ad-hoc entry (generalized lane invariant) |
| `discoverFieldDescriptors(records)` / `mergeFieldDescriptors` | `→ FieldDescriptor[]` | Zero-config field discovery from observed payload keys; explicit descriptors win deterministically |
| `groupingRuleForView` / `groupingDescriptorForView` / `recordGroupValues` / `lanesForView` | grouping axis resolution | the open `view-group` projection rule makes ANY descriptor the kanban axis; historical `groupBy`/`lanes` normalize at decode only; default is the `lane` binding; `EMPTY_LANE_ID` marks no-value membership, label overridable via `emptyLabel` |
| `recordsForView(view, records, fields)` / `searchRecords` | scoping / search | Filters and search range over any descriptor's extracted text |
| `treeForRecords(records, linkDescriptor)` | `→ { roots: TreeNode[] }` | Hierarchy as projection: every declared link path is tried in order so a stale primary parent value can still resolve through a valid fallback such as `parent_id`; durable record address is the tree identity when present, so duplicate human ids cannot collapse sibling rows; orphans root themselves, cycles cut at revisit |
| `treeProjectionForRecords(records, linkDescriptor)` | `→ { roots: TreeNode[], nodeByKey: ReadonlyMap<string, TreeNode> }` | The memoized tree SSOT: builds the hierarchy ONCE per `(records identity, descriptor identity)` (WeakMap keyed) and exposes an O(1) `nodeByKey` index (`recordViewKey` → node), eliminating the per-row full-tree rebuild + linear search category (O(n²) at 4418 records). `treeForRecords` reads through it |
| `record-id` path order | `payload.id` before `address` | A log fact address is the write target, not the semantic record id when the record declares its own id. Child links can point at the semantic id while writes still use `recordAddress(record)` |
| `compareSortValues(a, b)` | `→ number` | Total order over mixed sort values: numbers tier, strings tier (fractional keys), missing last |
| `syntheticFieldDescriptor(id)` | `→ FieldDescriptor` | `{ id }` is a complete valid descriptor (paths default `[[id], ['payload', id]]`) |
| `recordAddress` / `recordIdentityKey` / `humanizeSegment` / `isMachineToken` | helpers | Durable address lookup; UI/tree identity; display humanization; generic machine-string heuristic (no fixed address prefix) |
| `actionVisibleForView` | `(action, view) → boolean` | Action descriptor scoping by view kind/id |

## Dependencies

**Depends on:** nothing (pure computation, zero imports — leaf-extractable).
**Depended on by:** `show/VisualDatabaseSurface.tsx`, `show/field-editors.tsx`, `show/mount-visual-database.tsx`, `do-work/visual-database-actions.ts`, package tests.
