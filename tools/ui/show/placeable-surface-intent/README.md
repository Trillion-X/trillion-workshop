# placeable-surface-intent/

Browser-local event, drag payload, published-record decoder, and raw-entry
admission helpers for activating a placeable surface.

This folder does not know what a tab, container, sidebar item, chat message, or
command result is. Producers call `emitPlaceableSurfaceIntent(...)` or
`setPlaceableSurfaceDragData(...)`; a consumer such as screen-arrangement may
cancel the event and translate the payload into its own owner state.

Raw browser entries use the same final payload shape. The helper admits one
opaque browser-local subject and puts only `surfaceInput.subjectRef` on the
placeable payload. The shared subject store lives in
`placeable-surface-subject.ts`; it is not exported from the Runtime Kit public
root. It does not expose byte lanes, file type routing, package renderers, or
screen placement policy.

Drag-over checks use `hasPlaceableSurfaceEntryCarrier(...)` so browser/OS
carriers such as Finder files, URI lists, or text can be accepted before the
browser exposes readable item bytes. Drop admission still uses
`admitPlaceableSurfaceEntry(...)`, so there is one subject-backed pathway from
carrier to placeable payload.

`placeable-surface-record.ts` is the canonical parser for `kind:
placeable-surface` records in maintained `placeable-surfaces` /
`placeable-surface-list::*` array values, package-set record wrappers with a
`records` array, and legacy published-record rows. It returns a generic surface
catalog only; placement, tab creation, and package entry byte reads stay owned
by caller packages. Maintained list order is authoritative, so the parser
preserves input order instead of sorting by label, id, or order. The parser
normalizes `accepts_material_kinds` /
`acceptsMaterialKinds` into an `acceptsMaterialKinds` array on every decoded
surface so consumers can filter material compatibility without testing for a
missing field. A row's `route_input` (the input key an address under its prefix
gives, `/decisions/<id>` -> `id`) becomes `addressInput`: the arrangement never
opens such a surface without that input.

`open_placement` may also say where a floating window's centre sits (`anchor`, fractions of the screen), how
the window and the area behind it look (`looks`: `window` and `backdrop`, each a visual layer stack, decoded by
the exported `readOpenPlacement`) and whether a press outside closes it (`closes_on_outside`). An open request
may carry its own `openPlacement` (read from `openPlacement` or `open_placement`), which wins over the screen's.

`surface-completion-target.ts` (ported from the ui package, records seam only) reads a screen's completion target, `{ target, correlation }`, and sends a finished result to it (`dispatchPlaceableSurfaceCompletion`); the Record audio screen's panel reads one when it is opened to finish someone else's step.

`open-choices.json` lists the places besides its own a screen can be opened (a new pane beside, a floating window
of a chosen size and place); `open-choices.ts` gives them as `OPEN_CHOICES` (and `shownOpenChoices()`, those no show rule hides: each is the control `open.<id>`, `openChoiceControl`) with `withOpenChoice(payload, choice)`,
which lays a choice's `request` over an open request. Every caller that offers a screen (a sidebar row, a Find
anything result) offers these, so a new place is one row. `closeOwnScreen(element)` sends `SURFACE_CLOSE_EVENT`
(bubbling) from inside a screen: the container it is in closes that screen's tab, and a floating window holding
nothing else closes with it.

Hover-card DATA is decoded here too: `open_placement`, `preview_surface_id`,
`badge_source`, `description`, `glance` (read by `ui/show/surface-preview/surface-glance.ts`)
and `actions` (window events the owning app listens for) become `openPlacement`,
`previewSurfaceId`, `badgeSource`, `description`, `glance` and `surfaceActions`.

The parser also decodes current-item wrappers back to their published-record
row and infers `sourcePackage` from canonical package record addresses. That
keeps command-palette, sidebar, and screen-arrangement on one decoder instead
of each inventing a weaker package-entry inference path.

Material-only intents may omit a destination. The active screen arrangement
matches `material.kind` against owner-published `acceptsMaterialKinds`, then
passes the opaque `surfaceInput` to that owner. For surfaces that deduplicate,
the semantic instance is the resolved owner mount plus `surfaceInput`; producer
request ids do not create parallel tabs for the same subject.

Tests cover opaque `initial_arrangement` preservation; the decoder carries that
record data without interpreting or reshaping it.

`entry-context-intent.ts` resolves browser entry context, such as host, path, and
query values, to the existing placeable-surface payload shape. It reuses
`emitPlaceableSurfaceIntent(...)`; it does not create a routing system, import a
feature package, read durable state, or know product names.
