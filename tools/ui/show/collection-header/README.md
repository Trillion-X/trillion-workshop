# collection-header

The top of a page that holds a collection of things shared by a group of people: its title (with an optional info icon holding the words that explain it), one line about it, the people in it, its main buttons and a `…` menu, on one row.

## Files

| File | Purpose |
|------|---------|
| `CollectionHeader.tsx` | `CollectionHeader` and `collectionHeaderMenuRows` (under 480 px wide the buttons move into the menu). |
| `mount-collection-header.tsx` | `mountCollectionHeader(node, props)` for screens that are not React trees. |
| `index.ts` | The one import point. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `CollectionHeaderProps` | `{ kind?, title, lead?, mark?: { picture?, letters, colour? }, info?: { label, text, title? }, people?: AvatarGroupItem[], onPeople?, peopleLabel?, actions?: CollectionHeaderAction[], menu?: ActionMenuItem[], menuLabel?, onAction, inset?: 'none' \| 'list' }` | Every word and icon is the caller's. `inset` `list` starts the picture and title on the same line as a list's title under the header (a pursuit over its Messages). `info` draws the shared `InfoHint` beside the title; `mark` draws the place's picture (or its letters) before it; `mark.colour` is a palette id the letters' tile wears, painted by `screen-look/show/collection-header.css`. |
| `CollectionHeaderAction` | `{ id, label, icon, primary? }` | A button while wide, a menu row while narrow. |
| `collectionHeaderMenuRows` | `(actions, menu, narrow) => ActionMenuItem[]` | The menu's rows for a width. |
| `mountCollectionHeader` | `(node, props) => MountedCollectionHeader` | Mount outside React. |

## Invariants

- No product words; every press is reported by id through `onAction`.
- Narrow is decided by the header's own measured width.
- Set apart from what follows by space, no rule under it. Appearance: `parts/screen-look/show/collection-header.css`.

## Dependencies

**Depends on:** `../action-menu`, `../avatar-group`, `../button`, `../icon`, `../record-kind`, `../text`, `../info-hint`.

**Depended on by:** `src/workspace/spaces-screen.tsx`.
