# search-field

The one search box: a magnifier at its start and the words the person types, on the same surface as the toolbar controls beside it.

## Files

| File | Purpose |
|------|---------|
| `SearchField.tsx` | The box: coss `Input` of type search with a leading `search` icon; every other input prop passes through. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `SearchField` | `(props: SearchFieldProps) => JSX` | Renders the box. |
| `SearchFieldProps` | `Omit<InputProps, 'type' \| 'aria-label'> & {label: string}` | `label` is the accessible name ("Search library"); `placeholder`, `value`, `onChange`, `onKeyDown`, `onBlur`, `autoFocus`, `size` pass through. |

## Appearance

`screen-look/show/search-field.css`: the icon sits inside the start of the box and never takes a press; the box uses `--glass-bg-subtle`, `--border-primary` and a 12px radius, the ExpandableTabs `sm` group's surface, so a search in a toolbar reads as one of its controls. Inside a menu (`action-menu [data-slot=menu-search]`) floating-menus.css drops the border and background.

## Dependencies

**Depends on:** `../coss/ui/input` (Input), `../icon` (NamedIcon).

**Depended on by:** `../record-views/record-views.tsx` (the view bar's search), `../action-menu/ActionMenu.tsx` (a long menu's search), `../rule-filter/RuleFilter.tsx` (searching a field's values).

## References (anatomy only)

- 21st.dev 27914, search with a leading icon.
- Dropbox Dash's centred search: https://mobbin.com/screens/6adc7b3f-57c1-44f9-9b60-cd6137cf7826
