# pane-tab

The tab a pane's header and the sidebar's tab rows draw: a draggable group holding a title button and a separate close button.

| File | Purpose |
|------|---------|
| `PaneTab.tsx` | The tab: pill or scalloped shape, active and inactive looks through CVA variants, pin mark, close that takes no room until the tab is active, pointed at or focused; `wrapTitle` hangs something (the hover card) on the title button alone. |
| `PaneTabV2.tsx` | An alternative tab look with the same root and button structure, exported for callers that pick it. |
| `index.ts` | Exports both tabs, their variants and prop types. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `PaneTab` | `(PaneTabProps) => ReactElement` | One tab. |
| `PaneTabProps` | `{title, leading?, active?, shape?, pinned?, closable?, onClick?, onClose?, onDragStart?, onDragEnd?, onContextMenu?, onPointerEnter?, onFocus?, onDragOver?, onDrop?, wrapTitle?: (title) => ReactElement, nodeRef?, className?, testId?}` | `wrapTitle` wraps only the title button, never the close, so a hover card opens over the tab's name and pointing at its close shows nothing. |
| `paneTabVariants` / `PaneTabShape` | CVA variants / `'pill' \| 'scalloped'` | The tab's looks. |
| `PaneTabV2` / `PaneTabV2Props` / `paneTabV2Variants` | as above | The alternative tab. |

## Dependencies

**Depends on:** `react`, `class-variance-authority`, `lucide-react` (X, Pin), `../cn`; the close look is `parts/screen-look` `close-control.css`.

**Depended on by:** `parts/sidebar/show/SidebarContent.tsx` (`TabRow`, which passes `wrapTitle` with `SurfacePreviewCard` for tabs that are not active), `parts/screen-arrangement/show/ContainerHeader.tsx` (through the sidebar tab rows), `parts/ui/index.ts`.
