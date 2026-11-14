// packages/group/show/board-shortcuts.ts
//
// The board's keyboard-shortcut CATALOG — Society DATA, the SSOT for what the
// "?" cheat sheet displays, now made from the board's one command table
// (board-commands.json, parts/ui/show/command-table). The same table makes the
// command palette's board rows and the tips that name a shortcut, so the three
// cannot drift apart. This is purely DESCRIPTIVE: it names each shortcut and its
// display keys; it does NOT execute anything. The actual key handlers live in
// GroupBoardPanel's onKey effect — the table only documents them for the user.
// The blind `ui` ShortcutSheet renders this shape (`{ heading, rows:
// { label, keys }[] }[]`) with zero knowledge of what any row does.
//
// Every row there is VERIFIED against a real handler in GroupBoardPanel (no
// aspirational shortcuts — L116). Adding/removing a board shortcut = editing the
// handler AND its one DATA row in board-commands.json; the ui never changes.

import table from 'trillion-workshop/tools/organize-the-sidebar/show/board-commands.json';
import { shortcutGroups, type CommandTable } from '../../ui/show/command-table/command-table';
import type { ShortcutGroup } from '../../ui/show/keyboard-shortcuts/ShortcutSheet';

/** The board's commands: every row's title, keys, aliases, score and palette placement. */
export const BOARD_COMMANDS = table as CommandTable;

/** The cheat sheet's groups, made from the table. */
export const BOARD_SHORTCUTS: readonly ShortcutGroup[] = shortcutGroups(BOARD_COMMANDS);
