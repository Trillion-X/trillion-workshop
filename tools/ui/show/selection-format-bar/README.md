# selection-format-bar

A bar of formatting buttons that floats above a plain-text field while words in it are selected. The caller passes the field element, the commands (DATA rows: `id`, `label`, `icon`, and `wrap: [before, after]` or `prefix`, optionally `select_after`) and keeps the text; the bar only reports the new text.

## Files

| File | Purpose |
|------|---------|
| `SelectionFormatBar.tsx` | The bar. It shows only while the field is focused with a selection, and a press never moves the selection. |
| `selection-format.mjs` / `.d.mts` | `applyFormat(value, start, end, command)`: wraps the selection in marks or puts a mark at the start of each selected line; the same command on the result undoes it. |
| `index.ts` | Barrel export. |

## Dependencies

**Depends on:** `../coss/ui/button`, `../container`, `../icon`.

**Depended on by:** `../task-properties` (the description field).
