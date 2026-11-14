# ui/show/command-table/

One table of a screen's commands feeding the command palette, the keyboard-shortcuts sheet and the shortcut tips, so the three cannot drift apart. Blind: the table says what exists, the caller's runners say what each does.

## Files

| File | Purpose |
|------|---------|
| `command-table.ts` | `CommandTable` (key glyphs + groups of command rows) and what is made from it: `shortcutGroups` (the sheet), `paletteItems` (palette rows with keys as the hint, aliases and score, for rows that ask for the palette and have a runner), `keysOf`, `coachedCommand`. |
| `command-table.test.ts` | Node test over the board's real table: sheet keys, palette rows, alias search, coaching. |
| `shortcut-coaching.ts` | `coach(command, via, history, now)`: the tip naming a shortcut when a command was run the slow way; capped per command and per day, spaced out, off when the person turned tips off. Pure: the caller keeps the history. |
| `shortcut-coaching.json` | Its DATA: the slower paths, the caps, the spacing and every word. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `CommandRow` | `{ id, title, keys?, aliases?, score?, palette?: { section, icon, label? } }` | One command. |
| `paletteItems` | `(table, runners) => CommandPaletteItem[]` | Palette rows made from the table. |
| `coach` | `(command, via, history, now, rules?) => { tip, history } \| null` | Whether to name the shortcut now. |

## Dependencies

**Depends on:** `ui/show/command-palette` (item shape), `ui/show/keyboard-shortcuts` (group shape).

**Depended on by:** `group` (board-commands.json, board-shortcuts.ts, GroupBoardPanel.tsx).
