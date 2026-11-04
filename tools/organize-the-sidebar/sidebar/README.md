# Sidebar

Package-owned sidebar root component and catalog display.

Docked contained instances use screen-look's integrated panel surface; detached instances get a distinct surface. The inset docked app rail (not contained) paints screen-look's `glass-surface`, the same surface, corners and depth the screen-arrangement panes use, so it reads as one of the workspace's containers. Generic headerItems retain labels when expanded and icons when collapsed. The selected row's caller-action menu remains visible through ui/HoverReveal, while other rows reveal on hover/focus. Every placeable row and collapsed rail icon opens the shared `ui/show/surface-preview` hover card: a mounted preview screen when the surface names `preview_surface_id`, otherwise its `glance` DATA (or, with none, when it was last opened) and `description`; the card and the row's ••• menu both offer the surface's `actions` DATA plus Open in new pane. A `badge_source` channel paints a live count on the row; on a collapsed row only an unread notification shows, as a small red dot, and a count of new things shows nothing there (`read-data/sidebar-badge-marks.json`).

The app rail also serves narrow viewports, and what it offers at each width is DATA: `read-data/sidebar-settings-by-width.json` rows turn the rail's switches on or off while the window is narrower than a row's width (a narrower row wins). Below 768 px the rail keeps its Position control, so it docks on the left, right, top or bottom like on a desktop, and drops Show / Hide (it needs a pointer resting on the screen's edge to come back). With `stay_open` off at that width it starts collapsed, collapses again after a screen is chosen, and expanding or collapsing there does not overwrite the saved desktop choice. No code names a control next to a width; `DesktopSidebar` only asks whether a switch is on. The former fixed hamburger and modal navigation were removed. Whether the docked rail sits beside the work or floats over it is a measurement, not a width row: docked left or right, when opening it would leave the work narrower than a usable pane (screen-arrangement's `minUsableContainerWidthPx()`, the person's narrowest pane, 320 px unless changed) it opens over the work with the work dimmed behind it, starts collapsed, and closes after a screen is chosen or a tap on the work; when even its collapsed rail would, the work keeps the whole width and one Show sidebar button in the docked side's bottom corner opens it (`read-data/docked-list-fit.ts`). A phone and a narrow desktop window get the same answer, and Position still docks it on any side.

The shared rail prunes list headings that have no visible rows or caller-owned content after content hosts are attached. Nested lists keep a subdued vertical guide and elbow in the Expansion screen look, so hierarchy remains visible without adding app-specific list rendering.

`AppSidebar` accepts caller-fed `sections` (or a projected graph plus catalog), with no global catalog, published-reply or personal-source reads on that path. Search, header actions and row actions are caller inputs. Container chrome requires an explicit `instanceId`, `containerRef` and `capabilities`; only true capability fields enable controls. Without that configuration embedded navigation remains read-free. `persistPlacement=false` supports genuinely ephemeral mounts.

The same frame draws every container's tab bar (screen-arrangement `ContainerHeader`): `inFlow` places a contained frame in its container's layout beside or above the work and paints nothing of its own (popped out it takes the look's `glass-surface`; hidden until pointed at it floats over the container), `hostControls` leaves the frame's own Position/Collapse/Undock/Hide controls to the host, which draws them in its ⋯ popover, so the frame draws none, and `leadingContent`/`trailingContent` carry the owner's controls. Rows are not only screens: a row's `look` names a key of `ROW_LOOKS` (`tab` draws the shared `PaneTab`), `closable` gives it a close that reaches the owner as `onItemAction(item, CLOSE_ROW_ACTION)`, and `rowEvents` (drag start/end, drop, warm) hand drags and drops to the owner. The selected row is always scrolled into view, and no list viewport draws a scrollbar.

`ContainedSidebar` binds the same `SidebarFrame` used by the main sidebar to its own container and durable instance address. The frame never portals a contained instance to the body or changes document-root insets. Saved floating geometry is projected into current bounds without overwriting its preference. List-view preferences and new-list registration use caller scope; existing main addresses remain unchanged. Visual acceptance is recorded in the shared sidebar repair plan, not inferred from component tests.

## Files

| File | Purpose |
|---|---|
| `things-to-store-and-run.json` | Publishes the sidebar package entry, root component records, and root source-byte candidate. |
| `part.json` | The part's declaration. |
| `read-data/` | Pure readers and the sidebar's own DATA: settings switches and the width rows (see `read-data/README.md`). |
| `do-work/` | Writes: list edits, placement, view preferences. |
| `show/` | Browser sidebar UI. |

## Public source (what other packages may import)

This package declares three public source roots, so a cross-package import is
legal only from these: `do-work`, `read-data`, and `show`.

`show` became public on 2026-09-03, when the hand-rolled `ui` collection sidebar
was deleted and every surface that used it moved here. That is the point of this
package: other packages MOUNT it. A shared surface that other packages mount but
does not declare its show root public fails the package compiler with
`BRTK5016_OWNER_PACKAGE_SOURCE_IMPORT`, and the fix is the declaration, never a
refactor of the importing package.

⚠️ Mounting it inside YOUR surface requires `presentation="embedded"`. Without it
you get the APP RAIL, which docks to a window edge and reads the one durable
`sidebar-placement` record. There is a single placement record, so the last mount
wins: on 2026-09-03 four surfaces each took the shell rail and the founder watched
his Visual Canvas and lists disappear behind a Documents page list. `scope`
selects WHICH nav renders; `presentation` selects WHERE it lives. They are
different questions and getting the second one wrong is invisible in code.

- `presentation="app-rail"` (default): the shell's own rail. One mount, the shell.
- `presentation="embedded"`: a nav inside your container, laid out by
  `screen-arrangement` like any other panel, touching no placement record.

Mount it as `AppSidebar` and feed it a PURE projection of your own rows:

- a list inside your own screen (recordings, a document's pages, conversations): `sections`, the shared sidebar's own
  recursive rows (`NavSectionData`: a section per group, `sections` nested to any depth, row `actions` as DATA); worked
  examples `parts/documents/show/documents-page-sidebar.ts`, `parts/record-video/show/RecordVideoPanel.tsx`
- the person's own navigation lists: `buildProjectedCollectionsNav` + `projectedCollectionsToCatalogItems`
  (src/workspace/sidebar-lists.ts), the graph the editable lists are kept in

The single-list graph builder (`buildProjectedCollectionNav`) is deleted (2026-10-04): an embedded list drawn through
an editable collection graph showed the old collections chrome (pin and hide controls) on a list nobody edits.

Your rows stay your source of truth. Nothing is copied into sidebar membership,
so there is no second list to drift. Note that mounting this pulls its reads into
YOUR entry's closure, so your entry must declare `sidebar` in
`entry-read-scope-packages.json`.

Projected placeable rows normally try the generic open intent on row click before
calling the mount's `onNavigate`. Set `navigation: "local"` when the row's
ordinary click must stay with that caller (for example, selecting a page in the
current document). The row remains placeable for drag/drop and keeps the shared
preview and explicit Open actions.

## Rules

The mount accepts `surfaceInput.sidebar_capabilities` (`position`, `collapse`,
`undock`, `hide`, `resize`; only explicit `true` enables a supplied capability),
optional caller-fed `sections`, and the arrangement-owned `surface_instance_ref`.
An instance mounts inside its own container; absent identity preserves the main
shell rail. No instance identity or placement grant is invented from list scope.

- The sidebar renders catalog data supplied through package inputs/current state; it does not scan package-set folders.
- Root executable source is declared through the `package::sidebar::entry::sidebar`
  package entry and the `package::sidebar::entry-bytes::sidebar` source bytes
  address consumed by `component:sidebar`.
- Integrity metadata is not an executable source for the root scene. The package
  must not use package-set-local build-script paths for sidebar entry bytes.

## Placeable Surface Catalog

Sidebar placement choices read the configured `placeable-surface-list` input,
which maps to the app-owned maintained placement feed. For Bitfield Studio this
is `placeable-surface-list::main-workspace`. That feed is the app owner's
screen contract and may include chrome settings plus placeable-surface records.
`published-records` may still feed non-placement reply/settings data, but it is
not the active placement source.
