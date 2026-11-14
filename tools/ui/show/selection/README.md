# Selection behavior

## Live composition preview

`LiveCompositionPreview.tsx` plays a draft from its original media: the cut's
segments, laid-down sounds and pictures (`SpatialLayer`, draggable), looks and
adjustment layers, and captions (`captions`: `{ look, lines, measuredAt }`, a
caption style row, cut-time lines with their words, and the frame side the
style is measured on) drawn by the shared `caption-overlay` `StyledCaption`,
the same style row the burned-in subtitle is built from. Used by the media
editor's player (`src/workspace/media-edit/cut-player.tsx`).

## Searchable choices

`dom-choice-list.mjs` is a domain-blind DOM adaptation of BeautifulUI
SearchList/ApprovalCard. Supply items, accessible search label, form name, and
selected IDs. Filtering preserves selection and native FormData. Appearance
belongs to `screen-look/show/beautiful-ui-controls.css`.

Upstream: https://github.com/slev12397/beautiful-ui at
ff0f74d62d8be9d89bcb735b3632e31a6ccf88dc. MIT notice:
`../BeautifulUI-LICENSE.txt`. Source provenance:
`<checkout>/beautiful-ui/DESIGN-SYSTEM.md`.

## Movable contextual toolbar

`mountMovableToolbar` adds viewport-bounded pointer and keyboard movement to an
existing contextual action toolbar. The consumer keeps ownership of the toolbar,
its actions, selection state, and saved position. The helper owns movement,
clamping, resize recovery, and Escape reset without introducing product copy or
an additional action implementation.

Appearance belongs in `packages/screen-look`; consumers should expose the toolbar
as soon as one item is selected and keep secondary actions in their existing
shared menu.

## Timed layers

`timed-layer-editor.mjs` exports `mountTimedLayerEditor(host, {layers, label, fields, precisionFields, actions, onAction, makeRow, validate, addLabel, emptyLabel, removeLabel, duration, getTime, onChange, onSeek, timelineDriven})`: the one editor for rows placed on a video timeline. It renders through the shared `mountRecordEditor` (focused, reorderable, actions in the row menu) and returns `read`, `select(id)`, `append`, `reorder`, `patch`, `update(id, values)`, `remove`, `restore`, `destroy`. `timed-text-editor.mjs` (text), `adjustment-editor.mjs` (adjustments) and `timed-choice-editor.mjs` (timed looks) are field/action configurations of it; a new timed layer kind is another configuration, not another editor.

## Timed adjustment layers

`adjustment-editor.mjs` edits ordered, time-scoped picture adjustments. In
addition to brightness, contrast, and saturation, rows can carry bounded
exposure (-2..2), temperature (-1..1), and hue (-180..180) values. Existing
rows without those optional values stay neutral; live preview and export owners
consume the same row fields.

## Tray of picked things

`tray-store.ts` exports `makeTrayStore({ storageKey, limit?, storage? })` and `useTray(store)`: the things a person picked anywhere on the page (`TrayThing`: `{ key, kind, label, icon?, screen?, screen_label?, address?, id?, share_record?, context?, picked_at? }`), kept in the browser across screens and page loads, one of each key, newest kept past `limit`. The store stamps `picked_at` when a thing first joins, so a screen can say when it was picked. `pick-things.ts` exports `installPicking({ store, rules, ignore, screenName, contexts })`: while picking, a click adds the thing under the pointer and a dragged box adds several. Used by `src/workspace/tray.ts` and `src/workspace/tray-screen.tsx`.
