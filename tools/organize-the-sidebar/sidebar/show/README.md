# sidebar/show

Browser sidebar components and mount code.

`AppSidebar.tsx` reads the package inputs supplied by Runtime Kit and renders
desktop plus mobile sidebar chrome. It does not scan package folders and does
not own the visible product/menu list. It carries **no** product/agent
vocabulary (engine status, AI-agent health, sound, current-task, level) — the
sidebar is a dumb, blind, generic chrome+placement renderer. Any status or
control surface, if wanted, is published by its OWNING package as a record the
sidebar renders blindly; it is never hardcoded here.

`DesktopSidebar.tsx` measures the docked list against the work beside it (`../read-data/docked-list-fit.ts` with screen-arrangement's `minUsableContainerWidthPx()`): when opening it would leave the work narrower than a usable pane it opens over the work (a `data-sidebar-scrim` behind it closes it on a tap, choosing a screen closes it after the row's own click has run), and when even its rail would, only a `data-sidebar-open-toggle` Show sidebar button shows in the docked side's bottom corner. Browser proof: `test/sidebar-overlay-narrow.test.mjs`; live pictures: `scripts/prove-sidebar-overlay.mjs`.

`DesktopSidebar.tsx` offers each capability (position, collapse, undock, hide, resize) only while the host gives it, the width rows allow it and no show rule hides its control `<controls>.<capability>` (`controls` defaults to `sidebar`; the pane tab bar passes `arrangement.header.tabs`; declared in ../part.json `controls`). With its position control hidden the frame sits at `homePosition` (left for the window's sidebar, the default edge for a tab bar) and never on a seam, so a part with one place only draws no position control. A row's hover card is the control `sidebar.row-preview`, a tab's `arrangement.header.tabs.row-preview`, and its open choices come from `shownOpenChoices()` (test/show-types-and-controls.test.mjs). `DesktopSidebar.tsx` `SidebarFrame` also draws each pane's tab bar: `inFlow` (a contained frame taking its own place in its container's layout, painting nothing of its own), `hostControls` (the host draws the frame's own Position/Collapse/Undock/Hide controls in its own menu, so the frame draws none), `leadingContent`/`trailingContent` (the owner's controls) and `rowEvents`. `SidebarContent.tsx` rows carry `look` (a `ROW_LOOKS` key; `tab` = the shared `PaneTab`), `closable` (`CLOSE_ROW_ACTION` through `onItemAction`), `pinned`, `leading` and `nodeRef`; `NavRowEvents` hands drag start/end, drop and warm to the owner; the selected row is kept in view. Browser proof: `test/tab-bar-is-the-sidebar.test.mjs`.

`SidebarBar.tsx` is the thin bar the window's sidebar becomes when it is collapsed or sits on a seam between two panes: one line of icons along whichever way it lies (down a seam between panes side by side, across one between stacked panes), every icon, scrolling along the bar (wheel, trackpad or touch; a bar lying across scrolls sideways under a wheel too) when they do not all fit (`../read-data/bar-fit.ts`), with the open screen's icon scrolled into view; any past the person's At most bound sit behind More, whose menu holds that bound; empty space rows push the icons apart. `place-drag.tsx` drags it by its grip: let go on a seam (`ui/show/seam-slots`) or a window edge it docks there, anywhere else it folds to a small handle right where it was let go, and the handle opens the list over the work. Browser proof: `test/sidebar-anywhere.test.mjs`.

A list can host a shared panel instead of rows: the app's DATA `content_host_by_section_id` names the list and a
host id, the sidebar draws an empty element carrying `CONTENT_HOST_ATTRIBUTE` (`content-host.ts`), and the filler
mounts with `mountIntoContentHost(hostId, mount)`, which follows that element as the sidebar redraws, collapses,
moves or unpins the list.

A row a chip list holds (`ui/show/surface-chips`, such as New's) wears its chip right after its name, as in the reference "Candidates  New", with any count badge kept at the row's right edge; a row without a chip lets its name fill the row.

`CollectionManagerRow.tsx` is the "Add a list" row: its picker floats on the shared popover (`ui/show/coss/ui/popover`, the `menu` layer of `ui/show/layer-order`, the `floating-menus.css` surface), so it paints over the sidebar and its Layouts cards like every other menu; each list the person made has one "…" (the shared `ActionMenu`) holding Rename, When it shows and Delete, Delete asking once more. When it shows opens `ListShowsWhen.tsx` under the list's name: the shared rule filter (`ui/show/rule-filter`, the same menu and chips every record view's filter uses) over the facts surfaces.json marks `on: lists` (today's date, days since the list was made, the count an AI left on it), kept as the list's `shown_when`; "for 7 days" is Days since it was made is less than 7, "until a date" is Today is before it, and a rule with nothing in it takes the rule off. A named list is kept in the person's account through the group door and sent at once (`src/workspace/records.ts`), so a reload straight after naming it still shows it. Browser proof: `test/sidebar-add-a-list.test.mjs` (desktop and phone width).

Nothing is special-cased in the rail: a notification center, an inbox or any
other screen is an ordinary row from the same surface DATA as every other row.
Two optional fields on a surface record make a row richer without sidebar code
knowing what it shows:

- `preview_surface_id` names another surface whose live content a hover preview
  card shows (`ui/show/surface-preview/SurfacePreviewCard`, Base UI PreviewCard:
  hover intent, safe triangle, stays open while the pointer is inside). The card
  shows on the expanded row and on the collapsed rail icon; its heading opens the
  row's own surface, exactly like clicking the row.
- `sidebar_place: "controls"` puts a screen among the sidebar's own always-shown window controls (DesktopSidebar `controlItems`), drawn by the same `NavItem` as a row with its icon, live badge and hover preview: a notification bell. A placed screen shows there and in no list, even one the person put it in, and is never in the uncollected catalog ("Things"): `AppSidebar.tsx` `splitPlacedRows(items)` answers `{placed, listed}` (`placed` maps each place's name to its rows) and the lists read only `listed`, so the collapsed rail never draws one screen twice (`test/sidebar-rail-once.test.mjs`).
- `sidebar_place: "bottom"` keeps a screen at the foot of the navigation below every list (DesktopSidebar `footerItems`), in no list; `splitPlacedRows` answers each place's rows by its name. `sidebar_colour` (a hue of the screen-look palette, `--record-kind-<hue>`) draws the row in that colour (`data-colour` on the row, look in `screen-look/show/navigation-preview.css`).
- `badge_source` names a live badge channel (`ui/show/surface-badges`); the row
  shows that channel's current value (for example `notifications:unread`) in
  place of the static `badge`. How it shows is DATA
  (`../read-data/sidebar-badge-marks.json`), by what the badge counts (its
  `kind`) and whether the row shows its name: with the name, the grey number;
  on the icon alone (collapsed sidebar, controls), a small red dot for unread
  notifications and nothing for a count of new things, because red is kept for
  notifications. `NavItem` draws the mark through `RowBadgeMark` (shared
  `Badge` and `StatusDot`) and names no kind or screen.

By default, visible sidebar items come from the configured
`placeable-surface-list` input. For Bitfield Studio that input points at
`placeable-surface-list::main-workspace`, the same maintained catalog used by
the main workspace.

A direct React caller may instead pass `catalogItems` plus a matching
`surfaceCollectionsGraph`. This lets a live owner project its own SSOT into the
sidebar's generic group shape without copying rows into a second durable list.
`mount-sidebar.tsx` draws `surfaceInput.header_content_host` (a host id) at the top of the sidebar's header as an empty `data-sidebar-content-host` element an app mounts its own control into (Trillion's Focus switcher, `rule-filter/FocusEditor.tsx`), so the sidebar knows nothing of what it holds.

`mount-sidebar.tsx` passes `surfaceInput.placeable_surfaces` through as `AppSidebar`'s `knownPlaceableSurfaces`: the surface records the app itself publishes to its catalog address. The rail paints from them until the catalog read answers, and the answer replaces them, so an app opens its navigation without waiting on the engine.

Each screen shows in one list only, from every source (`read-data/merge-surface-collections.ts` `showEachSurfaceOnce`): where the person put it (a list of their own, or a row they added to their saved copy of an app list) wins over where the app puts it, otherwise the first list in the order shown keeps it, and a screen no list keeps shows in the uncollected catalog ("Things"), so nothing offered is dropped. `AppSidebar.tsx` `hideEmptySidebarLists` drops an app list with nothing in it, and a kept copy of a list an earlier sidebar offered, but keeps an empty list the person made (`listMadeByPerson`) while they can edit it, so they can drag or add its first row (`test/sidebar-each-screen-once.test.mjs`).

`use-surface-collections.ts` is the ONE reader of a person's lists: `useSurfaceCollections({scope, partitionLabel, graph, persistEdits})` returns `{collections, durableCollections, loading, error, refresh}` (projected graph final; with `persistEdits` the person's saved copy of each app list is laid over it and their own lists are appended, by `read-data/merge-surface-collections.ts` `mergeSurfaceCollections`; the first change to an app list saves it as shown in the same batch, `do-work/edit-surface-collections.ts` `saveAsShownFirst`), and `partitionLabelForSurfaceList(address)` is the one partition rule. The person's own lists and rows that hold or show by a rule (`read-data/apply-list-rules.ts`) are decided through `#workspace-list-rules` (src/workspace/list-rules.ts, the formula engine) and decided again when the soonest moment a rule names comes; until the first answer nothing that shows by a rule is shown. `AppSidebar` draws from it and screen-arrangement's empty pane calls it with the same arguments, so both always show the same lists.

`ProjectedCollectionNav.ts` is the pure builder for that projection. Its entry point is
`buildProjectedCollectionsNav`, for a caller whose rows arrive in NAMED GROUPS (the person's own lists),
where each group becomes a real collection the sidebar renders. The grouped form
is what lets a surface leave the now-DELETED `ui` collection sidebar without losing
its group headers; empty groups are dropped, because a titled group with nothing
under it tells the reader nothing. Pair it with
`projectedCollectionsToCatalogItems` (`projectedNavItemsToCatalogItems` turns one group's rows into catalog rows). A list
inside a screen (recordings, a document's pages) passes `sections` instead and never builds a graph. Generic
`searchValue`, `headerContent`, `emptyContent`, `headerItems`, and
`onItemAction` props stay caller-owned; the sidebar owns placement, chrome,
list decoding, list editing, and rendering.

When a caller also sets `persistCollectionEdits`, `AppSidebar` keeps those
uncollected caller sections in “All” and offers sidebar-owned lists over
the caller's catalog rows. A section can name `ownerSurfaceId` so its child
navigation follows that surface's row into a saved list, through the shared
row's `sections`; removing the membership restores the source outline. Ordinary
placement shows one row; a list explicitly declaring `repeats_rows` keeps its
repeated view. The caller's `scope` owns both the durable lists and
the saved view preference; changing scopes remounts this curated mode, and a
deleted or missing selected list returns the view to “All” after the list read
succeeds. This keeps scene-scoped callers such as Documents from inheriting a
stale selection from another scene.

Each row has one `•••` menu, `Actions for <label>`, drawn by the shared `ui`
`ActionMenu`. It shows the caller's `actions` (`NavItemActionData`: `id`,
`label`, a required Lucide `icon`, optional `tone: 'destructive'`, `disabled`)
and, for a row that belongs to a list, the sidebar's own "Remove from this
list" after a separator. There is no second list-actions popover.

A list's rows sort by the handle at their start (`data-reorder-handle`, the shared `ui` SortableRows): the row follows the pointer, the others slide aside and a line marks where it lands; ArrowUp/ArrowDown/Home/End move a focused handle. Only a list member has a handle. The row itself is dragged (native drag) to open its screen in a pane, or into another list. A caller's own row in an embedded nav is neither, so it has no handle and does not drag. `AppSidebar.tsx` is public (`part.json`) so a shared screen part can mount it embedded.

What a list offers is DATA at three levels, narrower winning (`../read-data/sidebar-settings.ts`): the sidebar's `sidebar_settings` (surface input), a list's `settings` (collection meta), and a row's own (the screen's `sidebar_settings`, then its list member's `settings`). Switches: `remove_from_list`, `add_to_list`, `reorder`, `move_between_lists`, `unpin`, `auto_hide`; each is on unless a level turns it off. A list's width is the sidebar's, so lists have no width buttons. An unpinned list keeps its heading in the sidebar with "Pin to sidebar", and its floating panel closes as "Pin ... to the sidebar". In the collapsed rail the unpinned list is its own icon, named "Pin ... to the sidebar", which pins it back, so the rail never shows a second pin beside Undock.

A long list stays short: a list whose DATA sets `show_at_most` (projected `showAtMost`, collection meta `show_at_most`) shows that many rows, then a "Show N more" row that opens the rest and turns into "Show fewer". The row of the open screen always shows, even past the cap. In the collapsed rail that row is an icon like every row there (more, or fewer), its words its name and tooltip, so the rail shows no number.
