# choice-list

A short list of rows a person ticks, any number of them: each row its mark, its name, an optional quiet line under it, and a round tick at the end that fills in when chosen. The whole row is the control.

## Files

| File | Purpose |
|------|---------|
| `ChoiceList.tsx` | The list. Rows are the caller's DATA; each row is one checkbox to assistive technology; chosen shows as a filled tick with a check and a firmer edge. |
| `index.ts` | The one import point. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `ChoiceList` | `({ items, chosen, onToggle, label, className? }) => JSX` | Draws the rows; `onToggle(id)` on a press, Space or Enter. |
| `ChoiceListItem` | `{ id, label, detail?, icon?, depth? }` | One row; `icon` is a NamedIcon name; `depth` (0 at the top) sets the row in under the one above it by `--choice-list-step` (1.25rem) per level, so a tree read in order draws as a tree. |
| `ChoiceListProps` | the props above | For callers that build them. |

## Invariants

- The round tick carries `corner-shape: round`, since the Twenty look's squircle rule would otherwise square it.
- Rows are drawn in the order given; nesting is only each row's `depth`, so a caller passes a tree already read in order (a pursuit, then the pursuits under it).

## Dependencies

**Depends on:** `../cn`, `../icon`, `lucide-react` (the check), the coss colour tokens.

**Depended on by:** `extension/src/popup.tsx` (where a send goes), `src/workspace/sharing-screen.tsx` (where shares go). Public in `parts/ui/part.json`.
