# action-menu

The one action menu every overflow ("…"), context and action-group menu renders through: each row has an icon, a label, an optional keycap shortcut, a tone, and an optional two-step confirm.

## Files

| File | Purpose |
|------|---------|
| `ActionMenu.tsx` | The component, row validation (icon required, scope check) and shortcut helpers. |
| `index.ts` | Barrel export. |
| `menu-rows.ts` | The page's one source of rows for what a menu is about (`provideMenuRows`, `useMenuRows`), and the same rows as DrillMenu sections (`drillSectionsOf`), so a ⋯ offers every tool, saved action and way of sending that applies to its thing without naming one. |
| `__tests__/action-menu.test.tsx` | Guards: no other file draws rows from the menu primitive; rows without icons or outside the menu's scope are refused; shortcut glyph order. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `ActionMenu` | `(props: ActionMenuProps) => ReactElement \| null` | Renders the trigger and the menu. |
| `ActionMenuItem` | `{id, label, icon: string \| LucideIcon \| {glyph}, group?, groupLabel?, tone?, shortcut?, confirm?, disabled?, target?, props?, items?, checked?, hint?, depth?, keepOpen?, reorderable?}` | One row, all DATA. `depth` sets a row in under the one above it (0 at the top), so rows given in tree order read as a tree without a submenu. `icon` is required; `items` makes the row open a submenu (on hover); `checked` shows a check at the row's end; `hint` is quiet end text (a count, the chosen bucket); `keepOpen` keeps the menu open after the pick (toggling several); `reorderable: false` keeps a row out of dragging. |
| `ActionMenuProps.onReorder` | `(ids: string[]) => void` | Rows show a grip on hover; dragging one reorders the top-level rows and reports the new order. |
| `ActionMenuProps.search` | `{placeholder, create?: {label, icon?, onCreate(name)}}` | A search box above the rows; typing narrows every level (a row stays when it or a row inside it matches). With `create`, typed words that match no row exactly are offered as a last row (`label` with `{name}` filled in) that hands them to `onCreate`. |
| `ActionMenuProps.header` | `ReactNode` | Content above the rows (a form, a note). |
| `ActionMenuProps.about` | `MenuThing` | What the menu is about; after its own rows it offers every row the installed source has for that thing, and hands those picks back to the source (pending, done and failed shown by `runCommand`). A menu with only `about` still draws its trigger. |
| `ActionMenuItem.panel` | `(close) => ReactNode` | The row opens this beside itself as its own level (the shared message box, a form); typing in it never moves through the menu. |
| `MenuThing` | `{kind, id, title, ...facts}` | What a menu is about, as the caller describes it. |
| `MenuRowSource` | `{peek(thing), rows(thing), act(thing, id)}` | What the page installs with `provideMenuRows`. |
| `useMenuRows` | `(thing?, open) => ActionMenuItem[]` | The source's rows for a thing, read when the menu opens. |
| `drillSectionsOf` / `drillRowsOf` | `(rows, close) => DrillSection[] / DrillRow[]` | The same rows for the shared DrillMenu (the pane's ⋯). |
| `matchingRows` / `moveRow` | `(items, query) => items` / `(ids, from, to) => ids` | The search and reorder rules, pure. |
| `ActionMenuProps.anchorPoint` | `{x, y}` | Opens the menu at a point (a right-click) with no trigger button. |
| `ActionShortcut` | `{key: string, modifiers?: ('meta' \| 'shift' \| 'alt' \| 'ctrl')[]}` | A shortcut; shown as one keycap per key and, when `bindShortcuts`, bound to the same action. |
| `checkActionMenuItems` | `(items, scope?) => void` | Throws for a row without a resolvable icon or whose `target` differs from `scope`. |
| `shortcutGlyphs` | `(shortcut) => string[]` | Keycap glyphs in macOS order (⌃ ⌥ ⇧ ⌘ key). |
| `ariaShortcut` | `(shortcut) => string` | `aria-keyshortcuts` value. |
| `matchesShortcut` | `(event, shortcut) => boolean` | Exact keydown match. |

## Design source

- 21st.dev originui "Dropdown Menu — Menu with icons" (id 385): popup padding, 6px rounded rows, 16px reduced-emphasis icons, full-bleed separators, keycap shortcut style.
- 21st.dev coss "Menu" (id 11561): the base-ui menu primitive vendored at `../coss/ui/menu.tsx`.
- the owner's workflow-canvas `NodeActionMenu` (icon, danger tone, two-step confirm), now an adapter over this component.
- Checked against Linear menus on Mobbin (https://mobbin.com/screens/83e65fd8-259c-4568-8fa6-5a2269ed4123) and Slite keycaps (https://mobbin.com/screens/2e1cc584-70e7-4698-b1da-bf1e6239b00f).
- Appearance lives in `packages/screen-look/show/coss-workspace.css` (`.action-menu`, `--color-destructive-muted`).

## Dependencies

**Depends on:** `../coss/ui/menu` (base-ui menu), `../action-feedback` (`runCommand`), `../drill-menu` (types for `drillSectionsOf`), `../coss/ui/button`, `../icon/NamedIcon` (`resolveNamedIcon`), `../kbd/Kbd`, `lucide-react`.

**Depended on by:** `../coss/workspace-controls.tsx` (`mountMenu`, `enhanceActionSelect`, `enhanceButtonGroup`, inline card and layer menus), `../coss/project-tree.tsx`, `../coss/action-prompt.tsx`, `../coss/candidate-field.tsx`, `../record-views/record-views.tsx`, `../node-actions/NodeContextMenu.tsx` (right-click menus), `packages/sidebar/show/SidebarContent.tsx` (row `•••` menus), `packages/workflow-canvas/show/NodeActionMenu.tsx`.

## Invariants

1. No row renders without an icon; a plain-text menu throws.
2. A menu with `scope` only takes rows whose `target` matches (an item menu takes item actions only).
3. The shortcut hint and the key binding come from the same row, so a hint cannot lie.
4. A menu opened inside a `[data-menu-anchor]` surface is placed against that surface, never over it.
5. A menu never names the rows it offers for its thing: they are the installed source's, and a new tool, saved action or format reaches every menu it applies to with no change here.
