# Documents Show

React rendering over engine snapshots, authored scene content, material data,
and generic action references.

This folder does not own persistence vocabulary or layout truth. The
composition engine returns frames; the authored scene content store persists
the root children, edges, and camera.

Action affordances are consumed as opaque records. Configuration forms render
their fields, steps, previews, defaults, and live option sources through the
shared `ui/show/action-affordance` primitive; this surface only supplies invoke
context, sends the workflow Envelope, and places returned artifacts.

## Surfaces / entries

| File | Purpose |
|------|---------|
| `mount-documents.tsx` | The editor entry (`documents`). Mounts `DocumentsSurface` at `props.scene_address` (defaults to the standalone documents address), so it edits whichever document it is pointed at. |
| `DocumentsSurface.tsx` | The block editor itself (blocks, formatting, input-shortcuts, edges, camera). |
| `documents-page-sidebar.ts` | Projects page scene nodes into the shape the OWNED sidebar reads, plus the page row-action rows. Pure: it writes no record, so page scene nodes stay the only page identity and order authority. |
| `CompositionSurfaceContent.tsx` | Renders the same `SceneNodeView` tree behind a `canEdit` gate. Every handler `DocumentsSurface` passes must also be threaded here, or the gated path hands the child `undefined`. |
| `mount-composition-scene.tsx` | The `composition-scene` entry. |
| `mount-selected-composition.tsx` | The `selected-composition` entry. |
| `AuthoredNoteEntry.tsx` | The `authored-note` entry. |
| `persisting-transaction-queue.ts` | Queues scene transactions so typing does not race persistence. |

## The pages rail is not ours

The rail beside the editor is the OWNED sidebar (`packages/sidebar` plus
`group`), mounted as `AppSidebar` with `presentation="embedded"` and fed by
`documents-page-sidebar.ts`. The `embedded` presentation is NOT optional: the
default is the app rail, and mounting that here evicts the shell nav and takes
the window rail instead of adding a panel to this container.

This folder holds no rail markup, no rail CSS and no rail geometry state. Where
this panel sits is owned by `screen-arrangement`, the same as any other panel in
the container. It reads and writes NO `sidebar-placement` record; that record
belongs to the shell rail alone.

Because this package mounts another package's surface, the `documents` entry
declares `sidebar` in `../entry-read-scope-packages.json`. Without that
declaration the entry-byte build refuses the whole package with
`BPS_ENTRY_READ_0102_CONSUMER_NOT_IN_PROVIDER_SHAPE`.

Two of the four inputs that declaration pulls in (`placeable-surface-list` and
`placeable-surface-list-by-address-label`) are the shell's surface catalog, which
a caller-projected sidebar never renders. `AppSidebar` reads the catalog
unconditionally and the closure analysis is static, so supplying `catalogItems`
replaces the feed at render time but not at read time. That over-declaration is
known and belongs to `packages/sidebar` to reduce.

The Documents rail scopes editable lists to the exact scene address. Its page
rows remain local framing actions on an ordinary click; the same rows retain
their scene address, page id and optional Space id in explicit Open and drag
intents. The shared sidebar keys the saved list view by that same scope and
returns to All if the selected list is deleted, so scene changes cannot strand
the rail on a list that does not belong to the current scene.

⚠️ The CSS in `DocumentsSurface.tsx` lives inside a template literal. A comment
containing a backtick terminates the string, and esbuild then reports a parse
error thousands of lines from the real cause.
