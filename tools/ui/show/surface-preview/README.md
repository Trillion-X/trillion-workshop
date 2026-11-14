# surface-preview

A compact work surface for any row that opens a screen: resting the pointer on a trigger opens one card with a heading that opens the screen, a live look at it (another screen mounted small, or a glance read from DATA: count, last change, in progress, recent items) and the screen's most useful actions as buttons. On a phone, tapping the row opens the same surface as the shared bottom sheet; its screen, actions and nested rows remain the same.

## Files

| File | Purpose |
|------|---------|
| `SurfacePreviewCard.tsx` | Base UI PreviewCard (hover intent with open/close delay and floating-ui `safePolygon`, so the card stays open while the pointer travels into it and while it is inside). On a phone, a tap opens the same live screen or glance inside the shared `phone-sheet` overlay. Body is either a `PlaceableSurfaceHost` of the previewed screen (`preview`) or the glance (`glance`), then an actions footer. |
| `surface-glance.ts` | Reads a screen's `glance` DATA (where to read and where each fact sits, as path arrays) and its `actions` DATA (each names a window event the owning app listens for); fills `{name}` placeholders per row; loads a glance on demand. |
| `surface-glance.test.ts` | Decoding, path reading, counts, per-row filling and event dispatch. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `SurfacePreviewCard` | `({label, icon?, trigger, onOpen, preview?, glance?, glanceParams?, description?, lastOpenedAt?, actions?, side?, align?, delay? = 350, closeDelay? = 180}) => ReactElement` | `trigger` is rendered as the hover trigger; `onOpen` runs from the card heading. `preview` wins over `glance`. With neither, the card still shows "opened X ago" / "not opened yet", the description and the actions. |
| `SurfacePreview` | `{label, icon?, packageEntry: {packageName, entryName}, materialTarget?, target?, surfaceInput?}` | What to preview, resolved from surface DATA (`preview_surface_id`). |
| `SurfacePreviewAction` | `{id, label, icon, onAction}` | One button in the card footer (`data-action-id`). |
| `describeAge` | `(time: number, now?) => string` | "just now", "5 minutes ago", "yesterday". |
| `GlanceDeclaration` | `{source: {url}, count?: {path, measure: 'length'\|'value', noun: [one, many]}, updated?: {path}, recent?: {path, title, detail?, time?, limit?, row?}, in_progress?: {path, title, progress?, when?: {path, equals[]}, row?}}` | The `glance` DATA on a surface record or project rows. Every path is an array of keys; `title` may be a list of paths, the first that reads wins. |
| `GlanceRowDeclaration` | `{values?: {name: path}, fields?: {name: path \| {text}}, open?: {event}, actions?: SurfaceActionData[], drill?: GlanceDeclaration}` | What makes a listed thing a row a person works: `values` are read from the item (and merged over the card's own params), then fill `{name}` in `open` (pressing the row), each action (an icon button on the row, for example open beside or as a window) and `drill`, a whole glance for what is inside that item, read in the same card with Back. Drill nests to any depth; each level passes its values down. An open or action naming a `{name}` the item has no value for is left out, so no row offers to open something with a blank id. `fields` are listing fields (icon, picture, tone, byline, text, value, unit); 0, false and empty say nothing and are left out. |
| `GlanceItem` / `readGlanceRow` / `readGlanceItem` | `{values, fields, open?, actions, drill?}` / `(value) => GlanceRowDeclaration \| null` / `(row, item, inherited) => GlanceItem` | A row's filled DATA; decode (malformed parts dropped); fill one item. |
| `Glance` | `{count?: {value, label}, updatedAt?, inProgress: {title, progress}[], recent: {title, detail?, time?}[]}` | What the card paints. |
| `SurfaceActionData` | `{id, label, icon, event: {name, detail?}}` | The `actions` DATA; running one dispatches a cancelable window `CustomEvent(name, {detail})`. |
| `readGlanceDeclaration` | `(value: unknown) => GlanceDeclaration \| null` | Decode; malformed parts are left out. |
| `readSurfaceActions` | `(value: unknown) => SurfaceActionData[]` | Decode; incomplete rows are left out. |
| `fillGlanceUrl` | `(url, params) => string` | `{name}` filled URL-encoded. |
| `fillSurfaceAction` | `(action, params) => SurfaceActionData` | `{name}` filled as text in the label and the nested event detail, so one declaration serves every row. |
| `readGlance` | `(declaration, reply, plural?) => Glance` | Follow the declaration's paths through a reply. |
| `loadGlance` | `(declaration, params?, fetcher?, signal?) => Promise<Glance>` | Fetch the filled source and read it. |
| `runSurfaceAction` | `(action) => boolean` | Dispatch; true when a listener took it (`preventDefault`). |

## Dependencies

**Depends on:** `@base-ui/react/preview-card`, `react`, `lucide-react`, `../icon/NamedIcon`, `../coss/ui/button`, `../placeable-surface-host/PlaceableSurfaceHost` (mounts the preview screen through the page's on-screen runner), `../layer-order`. Appearance: `packages/screen-look/show/navigation-preview.css` (`.surface-preview`, `.surface-glance*`, `.surface-preview-actions`).

**Depended on by:** `packages/sidebar/show/SidebarContent.tsx` (every placeable row and collapsed rail icon; glance, description and actions resolved in `AppSidebar.tsx` from the surface record), `packages/ui/show/coss/project-tree.tsx` (every project row when the tree is given `rowPreview`), `packages/ui/show/placeable-surface-intent/placeable-surface-record.ts` (decodes `glance` and `actions` with this reader).

## Invariants

- Blind: which screen is previewed, what its glance reads and which actions it offers are DATA; this folder names no screen, field or app.
- A glance loads when the card opens, never before and never on a timer; closing the card aborts the read.
- A row's open, its buttons and the card heading close the card after they run; looking inside never leaves the card, and closing the card returns it to the top level.
- The card is used by sidebar rows, collapsed rail icons, project rows and pane tabs (on the tab's name only, never its close, and never on the active tab, through `PaneTab` `wrapTitle`).
- A missing or malformed fact is left out; nothing is guessed.
- Desktop hover keeps its intent delay and safe pointer path. Keyboard still opens the named screen from the trigger. A phone tap opens the shared phone sheet, with a close control, drag grip, backdrop and working screen actions; tapping the heading still opens the full screen.

## References

21st.dev #11873 "Hover Card" by jshguo (open/close delay, side/align placement, fade and zoom from the trigger side), #221 shadcn "Hover Card". Mobbin: Tana sidebar flyout (recent items with times), Basecamp project summary (counts and latest activity), Mintlify project card (status line plus one primary action). Original code over Base UI PreviewCard.
