# tools/coach-keyboard-shortcuts/

One command table for a screen: every command with its keys, the palette (Cmd+K) items made from it so every command
can be found by typing, and shortcut coaching: a command done with the mouse shows a tip naming its keyboard shortcut,
a few times, then stops. Moved here byte for byte from Trillion-X/trillion (`moved-from.json` names each file's source
path, commit and identity); only the test's import of the vitest shim differs. It is a library the web client imports
(`part.json` `imported_by`), not a row the engine runs.

## Files

| File | Purpose |
|------|---------|
| `parts/ui/show/command-table/command-table.ts`, `README.md` | `paletteItems`, `shortcutGroups`, `keysOf`, `rowById`, `coachedCommand`: the palette and the shortcut sheet made from one table. |
| `parts/ui/show/command-table/shortcut-coaching.ts`, `shortcut-coaching.json` | `coach`, `tipsOn`: when a tip shows and when it stops (DATA). |
| `parts/ui/show/command-palette/command-filter.ts` | `filterCommands`: the palette's typed filter. |
| `parts/group/show/board-commands.json` | A real command table the test reads (the group board's commands). |
| `parts/ui/show/command-table/command-table.test.ts` | The original test and assertions. |
| `moved-from.json` | Where each file came from. |

## How to run the tests

```
node --test tools/coach-keyboard-shortcuts/parts/ui/show/command-table/command-table.test.ts
```
