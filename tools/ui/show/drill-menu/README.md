# drill-menu

One calm popover menu that drills down without limit: each level is DATA, and a row holding another level opens it beside itself (in place with Back inside a phone sheet).

## Files

| File | Purpose |
|------|---------|
| `DrillMenu.tsx` | The menu, its list rows, icon rows and nested rows; nested levels open as side popovers through the shared coss `Popover`. |
| `index.ts` | Public exports. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `DrillMenu` | `(props: DrillMenuProps) => ReactElement` | Draws one level; nested levels beside it, or in place with Back when `inPlace` (defaults to inside a phone sheet). |
| `DrillMenuProps` | `{ level: DrillLevel, onSelect(row: DrillRow), inPlace?, className? }` | `onSelect` hears a row without a level. |
| `DrillLevel` | `{ id, title, sections: DrillSection[], width?: 'menu' \| 'panel' }` | One level; `panel` widens it for a picker or a screen. |
| `DrillSection` | `{ id, label?, look?: 'rows' \| 'icons', rows?: DrillRow[], panel?: ReactNode, attrs? }` | A group of rows, one row of icon buttons, or any live part. |
| `DrillRow` | `{ id, label, icon, hint?, tone?: 'danger', checked?, active?, disabled?, keepOpen?, next?: DrillLevel, wrap?, attrs? }` | A row; `next` makes it open a level; `wrap` lets a drag handle own the button. |

## Invariants

1. Blind: no row, level or panel is named here.
2. Nothing under the pointer moves: rows keep their size whether pointed at, pressed or open.
3. One road at every size: side popovers on a wide screen, in-place levels with Back in a phone sheet.
4. A level opened by pointing stays open while the pointer travels into it; a press on its row keeps it open.

## Dependencies

**Depends on:** `ui/show/coss/ui/popover` (Popover with press-to-keep-open), `ui/show/phone-sheet`, `ui/show/button`, `ui/show/container`, `ui/show/text`, `ui/show/icon`, `lucide-react`.

**Depended on by:** `screen-arrangement/show/ContainerHeader.tsx` (the pane ⋯ menu).
