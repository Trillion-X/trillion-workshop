# parts/visual-database

Bitfield's visual-database surface, ported into Trillion with only its records seam changed, so every Trillion list offers its outline, timeline, swimlane, tree and summary views beside the list's own, and a list's DATA can run actions on its records.

The package text that describes the surface (its views, field contract, action descriptors, cell expressions) is the Bitfield package's own README (`packages/visual-database/README.md`); this README names what Trillion carries and how it is reached. Every difference from the package is listed in `scripts/port-sources.json` (part `visual-database`).

## How Trillion reaches it

The surface's screens (every `show/` file that draws through the app's shared `ui/show` components: `VisualDatabaseSurface.tsx`, `OwnerBound…`, `LazyOwnerBound…`, `MetricView.tsx`, `views/*`, `field-editors.tsx`, `rating-editors.tsx`, `add-field.tsx`, `cell-expression-editor.tsx`, `descriptor-mutation-recovery.tsx`, `record-inspection.tsx`, `notes-document.tsx`, `list-as-visual-database.tsx`, `offer-views-to-every-list.tsx`) live in Trillion-X/trillion-apps `web/parts/keep-lists-of-rows/show/`, beside the app's `web/parts/ui/show`; they import this folder's `read-data/`, `do-work/`, `source-data/` and the pure `show/` helpers below as `trillion-workshop/tools/keep-lists-of-rows/<path>`. The `show/` paths named in this README are those files.

- `show/offer-views-to-every-list.tsx` (imported once by `src/workspace/main.tsx`) registers one view per row of `source-data/views-offered-to-every-list.json` in `parts/ui/show/record-views/every-list-views.ts`. Every `RecordViews` list with more than one view then offers each row whose `needs` its fields fill (`read-data/visual-database-input-from-list.ts` `listFieldRoles`: first field names the record, the first date places it in time, value-declaring grouping fields sort lanes and swimlanes, a `parent` field nests it, number-like fields are summed, and a field holding several values (rule kind `tags`: a list's tags or links, such as the people on a task) draws as chips on each row).
- Every view's descriptor carries the list as a node graph (`topology`: each record a node named by its title and coloured by where it stands, a line to each record it sits under, from the list's nesting or its `parent` field), which the `nodegraph` kind draws through the shared `ui/show/node-graph` where a descriptor names it (it is not offered to every list: a list's one canvas is Draw, the board, `src/workspace/draw-design.tsx`); pressing a node opens its record (`context.open`).
- A list's own Group by (`context.groupLevels`) reaches every view as `view.sections`; the list view (Outline, Checklist) then sits its records under one heading per value of each field, nested in that order, each heading saying how many of its records are done with the shared bar, instead of the date headings. A record whose own value in a grouping field is itself, while others hold that value too (a feature its tasks are grouped under), is that heading (`sectionHeads`): it is not repeated as a row under it nor counted among the items, in its heading or in the list's done count. A field declaring `links` (the records it came from or leads to) draws each linked record by its name, never its id. Each row's More actions menu offers Open when the list opens a record (`context.open`).
- The view is drawn by the ported `VisualDatabaseSurface` itself, as a `section` (the list's toolbar is its heading, search and switch), over the list's records after its search and filters. Its code is fetched the first time someone opens one of these views.
- Actions: a record set's `view.actions` rows are this package's action descriptors; `do-work/run-record-action.ts` runs one on a plain record through the package's own interpreter (`do-work/visual-database-actions.ts`). The page answers the targets the rows name (`src/workspace/list-targets.ts`: `workshop.run-tool`, `slot::formula-engine`, and `own-api.request` for signed-in same-origin `/work/api/` requests). Record-set action prompts can use the shared HoverForm with a typed control, a record-value prefill and a nested input destination, while the target's existing owner still validates and applies the request.

## Files

| File | Purpose |
|------|---------|
| `part.json` | The files other code may import. |
| `prove-seven-views.mjs`, `prove-seven-views.json` | The live proof on a computer: signs up with a simulated passkey (test-helpers/passkey-account.mjs) at `--origin` (or `TRILLION_PROOF_ORIGIN`), then on that account makes a list, adds a field, edits a cell, reorders rows, saves a view and switches it through grid, board, timeline, schedule, form, node graph and metric; reads each step back from the page and from the list's records through the web shell's records door, prints one pass/fail line with both readbacks, writes a screenshot per step to `--shots`, stops with 1 at the first failed readback, and deletes the account when the browser closes. Paths, record types and the selectors (each naming the shell file it was read from) are its JSON. Test: `test/prove-seven-views.test.mjs` (fake page, no network). |
| `show/VisualDatabaseSurface.tsx` | The surface: list, board, timeline, swimlane, table, relationship tree, canvas, gallery, metric and node-graph views. |
| `show/OwnerBoundVisualDatabaseSurface.tsx` | The surface bound to an owner's descriptor and record targets (writable use). |
| `show/LazyOwnerBoundVisualDatabaseSurface.tsx` | The same surface, its code fetched when it is first drawn (a screen whose table is not its first paint). |
| `show/MetricView.tsx` | Metric cards over the record set (stat strip, score ring, metric row). |
| `show/views/NodeGraphView.tsx` | Records as a node graph over the shared `ui/show/node-graph`. |
| `show/views/FormView.tsx` | The `form` view kind: any list's records filled in one at a time (a questions page, an intake), each field through the shared field editors, opening on the first record still missing a value. |
| `show/field-editors.tsx`, `show/field-editor-kit.ts`, `show/rating-editors.tsx`, `show/add-field.tsx` | Field editors chosen by a value's shape. |
| `show/cell-expression-editor.tsx`, `show/reference-catalog.ts` | Editing a cell's literal-or-formula expression and the references it can name. |
| `show/grid-interaction.ts`, `show/timeline-grouping.ts`, `show/record-inspection.tsx`, `show/descriptor-mutation-recovery.tsx`, `show/visual-database-observation.ts` | Table keyboard and selection, timeline buckets, the record inspector, field/view save conflicts, interaction events. |
| `show/offer-views-to-every-list.tsx` | Trillion: registers the views of `source-data/views-offered-to-every-list.json` with every list. |
| `show/list-as-visual-database.tsx` | Trillion: one of those views of one list, drawn by the surface. |
| `read-data/visual-database.ts` | Decodes records, field, view and action descriptors into the surface's model. |
| `read-data/visual-database-input-from-list.ts` | Trillion: a list's fields and records as that model's input; `listFieldRoles`, `listCanDraw`. |
| `read-data/addressed-descriptors.ts`, `read-data/descriptor-projection.ts`, `read-data/serialize-fields.ts`, `read-data/grid-style.ts`, `read-data/metric-aggregation.ts` | Descriptor records, their projection and writing back, the grid style cascade, metric reducers. |
| `do-work/visual-database-actions.ts` | The action interpreter: an action row and a record become the target requests it names. |
| `do-work/run-record-action.ts` | Trillion: run one action row on one record of any list. |
| `do-work/list-record-writer.ts` | Trillion: `listKeeper(read)`, the surface's record writes and tree placements as a list's own changes (values, a new row, the rows under a row, a removed row), one at a time, each checked against the list read back. |
| `do-work/record-writes.ts`, `do-work/mutation-settlement.ts`, `do-work/descriptor-*.ts`, `do-work/cell-*.ts`, `do-work/expression-owner-*.ts`, `do-work/resolve-derived-fields.ts`, `do-work/fractional-order.ts`, `do-work/migrate-descriptor-aggregates.ts`, `do-work/split-legacy-descriptor-aggregates.ts` | Writes, their settlement, descriptor changes, cell expressions and derived values, ordering keys, descriptor migration. |
| `source-data/views-offered-to-every-list.json` | Trillion DATA: the views every list is offered and what each needs. |
| `source-data/list-mutation-settlement.json` | Trillion DATA: the settlement policy a list's writes settle under (read back within 20 s). |
| `source-data/descriptor-reference-rules.json` | Which descriptor fields may reference which. |
| `source-data/answered-by-the-web-shell.json` | The `tools/ui/show` folders this tool names but the web shell owns (its build answers them, trillion-apps `web/scripts/workshop-shell-imports.mjs`); only bundled files may import them, as types. Test: `test/imports-resolve.test.mjs` (every other relative import resolves here, and `lists.mjs` loads in node with every file it reaches). |
| `test/list-keeper.test.mjs` | Old trillion's list-keeper test: `listKeeper` over the real `lists.mjs` and the computer's store (`keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs`). |
| `source-data/published-for-every-consumer.json` | Trillion: the two package-manifest rows a consumer's own Visual Database reads (the `mutationSettlementPolicy` input descriptor and the settlement policy), copied unchanged; read by the Record audio screen. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `VisualDatabaseSurface` | `(props: VisualDatabaseSurfaceProps) => JSX` | The surface (`model`, `presentation`, `initialViewId`, `writeRecord?`, `onInvokeAction?`, `onPlaceRecord?`, `detailFields?`: the owner's zoom step, 0 the name alone, null every fact). |
| `decodeVisualDatabaseModel` | `(input: DecodeVisualDatabaseInput) => VisualDatabaseModel` | Records plus descriptors to the model. |
| `visualDatabaseInputFromList` | `(context: ListContext, row: OfferedViewRow) => DecodeVisualDatabaseInput` | A Trillion list as that input, in nesting order; editable when the list hands `write`. The field the nesting is kept in (`ListNesting.field`) is the rows' structure and is never drawn as a fact. |
| `listKeeper` | `(read: () => ListContext) => { writeRecord, place }` | A list's writer for the surface: `writeRecord` keeps a record write, `place` moves a record under another (or to the top) before a sibling. |
| `listChangesFromWrites` / `listPlacementChanges` | `(context, writes) => ListRecordChange[]` / `(context, move: ListPlacement) => ListRecordChange[]` | The list changes one batch of surface writes, or one move, asks for; a move into a record's own sub-tasks throws. |
| `listFieldRoles` / `listCanDraw` | `(fields) => ListFieldRoles` / `(row, fields, nested?) => boolean` | What each field is for; whether a view is offered. |
| `doneValuesOf` | `(field, {done_tones, done_values}) => string[]` | The declared values of a field that mean done (the `done` rule of `views-offered-to-every-list.json`); `listFieldRoles` and the record views' Sprints design read it. |
| `recordActionsFromRows` / `runRecordAction` | `(rows) => VisualDatabaseActionDescriptor[]` / `(action, {id, title, payload}, value?, answers?) => Promise<unknown[]>` | Decode a list's action rows; run one on a record. `answers` (a person's list passes the row's values) is read by `copy` as `answers.<field id>`. |
| `invokeVisualDatabaseAction` | `(action, context, sender?) => Promise<unknown[]>` | The package's interpreter. |

## Dependencies

In this package: `tools/turn-frames-into-slides/read-data` (`group-graph.ts`, `visual-layer-types.ts`), `tools/ui/show/canvas-history/command-history.ts`, `tools/run-work-later-or-on-a-repeat` (wall time), `tools/record-log`, `tools/bounded-walk.mjs`.

**Depends on:** `parts/ui` (shared components, `record-views/every-list-views.ts`, `node-graph`, `inspector-sidebar`, `reorder-control`, `open-surface-action`), `parts/file-content-renderer`, `parts/screen-arrangement/show/FloatingPanel`, `#workspace-records` (src/workspace/records.ts) for every request.

**Depended on by:** `src/workspace/main.tsx` (registration), `parts/ui/show/record-views/record-set.tsx` (actions), `parts/ui/show/record-views/designs/sprints-design.tsx` (`doneValuesOf` and the `done` rule), `parts/record-audio` (its library surface).

## Invariants

- In a Trillion list the views are read-only: the list's own screen owns its records.
- Adding a view every list offers is one row in `source-data/views-offered-to-every-list.json`; adding an action is one row in a list's DATA.

## How a saved view is drawn (`display`)

`read-data/saved-view-engine.mjs` `normalizeSavedView` keeps an optional `display: { as, settings? }` on a saved view. `as` is a plain name (`/^[a-z][a-z0-9-]{0,40}$/`) of any view the list offers; `settings` is plain JSON for that view, with no functions and no `__proto__`, `constructor` or `prototype` key at any depth. `display: null` (or leaving it out when saving) returns the view to the plain list. The engine never reads `settings` or names a view; the MCP tools `save_list_view` and `read_list_view` (`src/list-tools.mjs`) carry it, and the share copy (`src/list-copy.mjs`) lists each drawn view with the ids of the rows it keeps. Tests: `test/lists.test.mjs`, `test/list-copy.test.mjs`.

## Fields that reach through links

A saved view's rules, sort, groups, columns and time range may name a path through links written `link.field` (`company.employees`, `company.parent.name`; at most `limits.path_hops` steps in `src/lists.json`). `src/list-paths.mjs` resolves it against the lists (`bad_path` when a step before the last is not a link field of the list before it) and reads its values from the lists that own the linked rows for the rows being shown, so `normalizeSavedView` and `projectSavedView` see an ordinary field. A path through links that each hold at most one row keeps the field's kind; a path through a link that can hold several rows is the list of their values (kind `tags`). Nothing is copied into a stored row. Test: `test/list-row-operations.test.mjs`.

## Views kept on their own, read with parameters, held still

- **One record per saved view.** `src/lists.mjs` keeps each saved view as `list-view:<list>:<view>` `{ list_id, view, order }` (`src/lists.json` `view_records`), so adding, changing, ordering (`move_list_view`) or removing one view never rewrites the list or its siblings. Views a list kept inside itself before are read as before, ahead of its own records; ordering gives every view a record first.
- **A field's shared form.** A view may name `<field>~key` (`website~key`) wherever it names a field: the value in the shared form its normalizer gives (`src/list-identity.mjs`), worked out for the rows being shown and never kept, so "the same company by its domain" is one rule.
- **Parameters.** A rule value written `{ "parameter": "owner", "default"?: value }` takes the value the reader gives (`read_list_view` `parameters`); one not given with no default refuses the read (`missing_parameter`), never drops the rule (`src/list-view-parameters.mjs`). `list_list_views` names each view's parameters.
- **Rollup fields.** A field of kind `rollup` (`{ through, field, op }`) is worked out on every read from the linked rows by the formula engine (`src/list-rollups.mjs`); a view compares it as the kind its measure answers (`aggregates` `answers`).
- **Snapshots.** `take_list_snapshot` keeps the ids a view held (`src/list-snapshots.mjs`); `read_list_snapshot` reads a range of them by id, now, and `read_list_aggregates` `snapshot_id` totals them, while the list goes on changing.

Tests: `test/list-view-records.test.mjs`, `test/list-unique-keys.test.mjs`, `test/list-rollups-and-copies.test.mjs`, `test/list-core-native.test.mjs`.
