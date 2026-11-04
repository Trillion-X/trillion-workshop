# Command Palette Show

Browser UI and mount code for the Command Palette package.

## Files

| File | Purpose |
|---|---|
| `CommandPalette.tsx` | Floating keyboard-driven palette UI. |
| `CommandPaletteGate.tsx` | Root gate that handles Cmd+K, asks for current-item results, and runs selected results. |
| `read-palette-results.ts` | Converts current-item replies into palette item/results data. |
| `match-ranges.ts` | Where the words typed sit in a result's words, as the ranges the palette marks (bold, amber) for a result that brought none of its own. |
| `palette-types.ts` | Shared source-owned palette item/result types. |
| `mount-command-palette.tsx` | Package entry mount function. |

## Rules

- Palette result shapes are source-owned types, not generated artifacts.
- The UI stays generic over item display fields and placeable-surface payloads.
