# screen-arrangement

Mounted tabs receive `surface_instance_ref` derived from the durable layout persistence identity and tab id. It survives a delivery-address change or container move and distinguishes separate tabs/layouts. The browser-local `surface_intent_destination_ref` remains a routing address, never a persistence identity. When no durable layout owner exists, no durable instance ref is invented.

## Configurable controls in Trillion

`show/ArrangedContents.tsx` supplies caller-owned shared controls to the existing
embedded arrangement through an exact-ID local surface catalog. The caller keeps
its records, callbacks, validation and copy; the arrangement keeps placement in
the account's ordinary layout record. Both screens and controls therefore use
the same split, resize, tab and persistence behavior. Controls take their natural
content height, and nested arrangements measure only their own panes.

The innermost pane under a drag owns its edge. Native capture listeners and React
handlers leave nested pane events with that pane, including when the hosted
screen has a separate React root. The surrounding pane still accepts drops in
its own content outside that nested arrangement.

## Purpose

Screen-arrangement package material: a routed slot that owns arrangement transitions plus package-owned bytes for putting the arrangement on screen.

The `thing-to-put-on-screen/` source is package-owned code. It asks generic Runtime Kit targets for published placeable surface records and emits generic screen snapshot operations. Runtime Kit core does not parse screen-arrangement state and does not own a component map.

## Files

| Path | Purpose |
|---|---|
| `things-to-store-and-run.json` | Package boundary data for the slot, screen entries, input descriptors, workflow actions, canonical direct layout-state seed, legacy migration input, and admitted thing-to-put-on-screen bytes. Placeable surface lists are only read through an explicit address label carried by the owner. The slot executable is admitted from the package-owned `slots/screen_arrangement.wasm` artifact because live source-proposal scratch imports do not include the Rust workspace root required by `source/Cargo.toml`. |
| `layout-library.json` | DATA: the layouts' kept-library row (`parts/group/read-data/kept-library.ts`): the index group of their categories, the category and member address families and id prefixes, how many Recent shows. |
| `kept-layouts.json` | DATA: how many arrangements the Layouts picker keeps by itself (`keep_at_most`). |
| `switch-layout-past-edge.json` | DATA: scrolling past the arrangement's edge to the next or previous layout (`least_motion_px`, `pause_between_switches_ms`, `edge_tolerance_px`). |
| `pane-sizes.json` | DATA, every person's starting pane sizes (`defaults`) plus the TuningPanel `sections` the Panes settings draw: how small a pane can be dragged (`drag_minimum_px`, 20), the size its screen is still laid out at (`content_minimum_width_px` × `content_minimum_height_px`, 320×240; the sidebar's docked fit keeps the work this wide), how far its cut edges fade (`cut_fade_px`), the share a new split takes (`new_pane_share_percent`), and snapping (`snap_on`, `snap_points_percent`, `snap_within_px`, `snap_ease_ms`); read by `read-data/pane-sizes.ts`, where the person's own choice wins key by key. |
| `.bitfield-entry-scope/` | Generated entry-scope adapter files used when building the package-owned screen entry. |
| `entry-read-scope-packages.json` / `entry-to-package-data-map.json` | Package-owned read-scope metadata and exhaustive source mapping for registered package entries. |
| `show/` | Browser React source for the screen-arrangement entry. |
| `show-ios-jscore/` | JavaScriptCore screen-atom mount for Apple app shells. |
| `read-data/` | Pure decoders for layout state, presets, published records, and placeable surfaces. |
| `do-work/` | Package-owned request builders for slot operations and owner write actions. |
| `thing-to-put-on-screen/` | Package source consumed by shells that can put screen things on screen. |
| `source/` | Rust WASM slot source for arrangement state transitions. |
| `slots/` | Built package slot artifact admitted by Runtime Kit. |

## Boundary

Runtime Kit validates, hashes, and admits the declared bytes. The package owns the source and the screen thing record. The iOS shell matches only `thing-to-put-on-screen` and runs the exact admitted bytes through its shell-local screen host.

Legacy row/table inputs in `things-to-store-and-run.json` stay as live
`selected_payload` descriptors. They are compatibility read lanes for older
records and caller-owned catalogs, not static entry-scope seeds. Keeping them
out of static seeding lets the screen entry import before it resolves the
log-owned payload selected by the caller.

The slot executable declared in `things-to-store-and-run.json` is the
package-owned `slots/screen_arrangement.wasm` artifact. The Rust source under
`source/` remains the implementation source for rebuilding that artifact, but
the live package implementation importer copies package folders into a
source-proposal scratch without the Rust workspace root. Admitting the artifact
keeps the live importer deterministic and prevents workspace-inheritance
failures from becoming runtime package-state failures.

## Application composition

`read-data/application-composition.ts` is the generic application-shell
primitive. It validates and folds a stable-ID ordered scene-root set, projects
only screen-arrangement-owned scene/projector records, and routes every other
capability as an opaque owner-addressed contribution. The primitive has no
product catalog, theme list, onboarding vocabulary, or surface-owner branch.

The selected package set carries exactly one product composition in its
`package-set-records/` DATA. That folder is ordinary content inside the package
set, not another package set. This package retains only the generic projector
template, decoder, planner, and handlers. The invocable
`plan-application-composition-transition` entry compares previous/next selected
composition DATA, accepts byte-equivalent retries, rejects conflicting equal
revisions, and emits one deterministic operation stream with a global
retract-before-upsert barrier.

Each contribution owner publishes its own discoverable descriptor with the
opaque owner reference, target, allowed thing types, and positive address
authority. `dispatch-application-composition-transition` invokes those targets
in order and rejects returned things outside the selected owner's authority. It
returns one ordered package delta for admission under the owner's complete standing approval
writer and performs no live write. Dependency references that require no write
remain package-set DATA; this package does not impersonate their owners.

`build-application-surface-catalog-contribution` is one of this package's
owner-specific contribution handlers. It turns an opaque placement label into
the existing ordered `record_from_matching_records` catalog contract.

An application that presents a deliberately narrow product adds
`config.only_surfaces_matching`, an array of match predicates appended to that
fold. WHAT AN APPLICATION OFFERS IS NOT WHAT IT CAN PLACE: a surface left out of
the catalog is still published, still addressable, and still placeable by
anything asking for it by id, so narrowing the offer never removes the
capability. The alternative, which this exists to make unnecessary, is stopping
the surfaces being contributed at all, and that is an edit in every contributing
package and an application's preference written into shared packages.

The predicates pass through unread, because the operator vocabulary belongs to
the matcher that evaluates them and a copy of that list here would be a second
place to update. One operator per predicate is enforced: the runtime matcher
evaluates the first set operator and ignores the rest, so a two-operator
predicate silently drops a condition, and a silently dropped condition is how a
restricted product quietly stops being restricted.

Nested
workspace layout remains ordinary `screen-arrangement` layout-state DATA.
`build-application-layout-state-contribution` seeds the row's explicit default
at the canonical address without overwriting user-persisted state. The
application row does not duplicate or reinterpret layout physics.

## Reference-Grounded Screen Contract

### Live Package Truth

- Package set: Bitfield Studio source package workshop.
- Package: `screen-arrangement`.
- Source root: `<checkout>/packages/screen-arrangement/`.
- Boundary file: `things-to-store-and-run.json`.
- Runtime snapshot reference: `<checkout>/runtime-package-set-snapshots/bitfield-studio-restored-runtime-packages-2026-06-13/screen-arrangement/`.

### Human Job

- Primary job: arrange generic package surfaces into tabs, split panes, floating windows, and overlays.
- Dominant action: change the current layout and persist the user's current arrangement.

### Capability Inventory

- Real capabilities to expose: owner-addressed placeable surfaces, persisted layout state, layout presets, embedded package entries, and package-owned JavaScriptCore/browser mounts.
- Hidden capabilities: Rust slot transition math remains behind `slot::screen-arrangement`; persistence is declared in package data and executed through configured owner actions.

### Reference Inventory

- Local references: restored runtime snapshot `show/`, `read-data/`, `do-work/`, `show-ios-jscore/`, and its package README.
- Architecture precedent: embedded workspace packages declare direct JSON layout-state records at `["current-item", "published-record"]` and read them through input descriptors with `source_bytes.bytes_to_value = "json"`. Older logs may carry previous row/table families; those are migrated forward once instead of staying active forever.

### Reference Anatomy

- Layout: full-viewport arrangement owner with nested containers, tab chrome, placeable-surface picker, saved-layout controls, split tree, canvas, and overlay layers.
- Density: operational workspace density; controls stay in chrome and popovers, not explanatory page copy.
- Typography and surfaces: inherited from shared package UI/screen-look primitives used by the restored source.
- Motion: disclosure and arrangement motion stay local to the restored screen-arrangement components.
- States: empty container, sparse one-tab layout, dense multi-container layout, loading/missing inputs, action errors, mobile/narrow and desktop/wide surfaces.

### Translation Boundary

- Banned user-facing terms: `attribute_fact`, `record_from_matching_records`, `layout-state/fact`, `cell_table`.
- Human terms: layout, tab, pane, canvas, overlay, saved layout.
- Data-to-control mapping: package input `layout-state` yields the whole layout JSON value from the canonical `screen-arrangement-layout-state` label; placeable surface lists come from the owner-provided `placeable-surface-list-by-address-label` parameter. The React mount fails closed when that prop is absent, so the package no longer silently chooses the old `placeable-surface-list::main-workspace` label-hash record family as current truth. Owner feeds may be raw placeable-surface arrays or package-set record wrappers with a `records` array; the shared `ui` decoder owns that translation. Legacy row/table inputs are live selected-payload reads so entry-scope import does not try to materialize stale table bytes before the caller-selected payload exists. Legacy `layout-state` RTBL bytes are migration-only and not an active write target.

### Shared Primitive Plan

- Reuse: `packages/ui`, the shared placeable-surface entry-context intent primitive, package input descriptors, direct JSON records, and the existing `slot::screen-arrangement` transition primitive.
- Elevate: no new shared UI primitive is introduced by this source-home restoration.

### Render-State Matrix

- Empty: default direct JSON layout has one empty tab in one pane.
- Sparse: one package surface tab persists as a whole layout JSON value.
- Dense: multiple split/floating/overlay containers persist through the same whole-payload value address.
- Loading: missing unreadable canonical `layout-state` input falls back to the package default layout; missing placeable-surface address truth fails closed instead of selecting an internal default; older logs may bootstrap once from the legacy RTBL input before persisting the canonical record.
- Error: mount-level error boundary renders the screen-arrangement root error.
- Mobile: full-viewport fixed root uses stage insets and existing responsive component behavior.
- Desktop: full-viewport fixed root renders the restored workspace arrangement surface.

### Visual Proof

- Capture path: source-home UI restoration is verified with package tests, live-log admission, and app-open browser proof for product package sets that provide the root scene.
- Acceptance checks: no active source-home `record_from_matching_records` layout-state path; `package::screen-arrangement::input::layout-state` reads JSON from `screen-arrangement-layout-state`; the old `layout-state` label is migration-only; top-level mount persists through `valueAddressLabel: "screen-arrangement-layout-state"`; entry-context opening only resolves owner-provided placeable-surface records through shared `ui` helpers; package-set record wrappers decode through the same shared primitive; no product route names are hard-coded; no package boundary input silently reads `placeable-surface-list::main-workspace`.
