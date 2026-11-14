# ui/show/icon/

Pure browser-local icon rendering.

| Path | Purpose |
|---|---|
| `Icon.tsx` | Size/color wrapper for a caller-provided Lucide component. |
| `NamedIcon.tsx` | Resolves caller-owned Lucide icon names without making feature packages keep finite icon maps. |
| `named-icons.ts` | The icons `NamedIcon` resolves: all of Lucide on disk; a browser bundle replaces it with only the icons the repository's files name (`scripts/named-icons.mjs` `namedIconsPlugin`), so no icon list is kept by hand. |
| `index.ts` | Local barrel export. |

## Key Types / Functions

| Name | Shape | Role |
|---|---|---|
| `Icon` | `({icon, size?, ...}) => JSX` | Draws a caller-provided Lucide component at a size and colour. |
| `NamedIcon` | `({name, fallback = 'Zap', ...}) => JSX` | Draws the icon a DATA name names (`Trash2` or `trash-2`); an unknown name draws the fallback. |
| `resolveNamedIcon` | `(name) => LucideComponent \| null` | The same name-to-icon resolution, for parts that take a component. |

## Dependencies

**Depends on:** `lucide-react`. **Depended on by:** every shared part that draws an icon from DATA; the workspace and extension builds give `named-icons` its bundle subset.

Rules:

- No addressed reads, target invokes, owner actions, or feature/package meaning.
- Icon names are caller data. Unknown names fall back visually; they do not become package routing decisions.
- Nullable copied-surface names are normalized by `NamedIcon`; the base `Icon`
  keeps only component-or-string icon inputs.
