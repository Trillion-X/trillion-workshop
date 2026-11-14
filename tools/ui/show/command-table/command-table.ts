// parts/ui/show/command-table/command-table.ts
//
// =============================================================================
// PURPOSE — One table of commands feeding the palette, the shortcut sheet and the tips
// =============================================================================
//
// A screen's commands are one DATA table: each row has an id, a title, the keys that run it, other words that find it,
// a default score and, when the palette offers it, the section and icon it files under. This file turns that one table
// into the three things that used to be kept apart and drifted: the rows of the command palette (`paletteItems`), the
// groups of the shortcut sheet (`shortcutGroups`) and the key text a tip names (`keysOf`). It is BLIND: it knows no
// command; the table says what exists and the caller's runners say what each does.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. A command is a row of the caller's table. Adding one is a row (and a runner when the palette offers it).
// 2. Key tokens are names (`mod`, `shift`, `opt`, `ctrl`, or a literal like `G`); the glyph each token is drawn with is
//    the table's own `glyphs` row, so the sheet, the palette hint and a tip always spell a combination the same way.
// 3. A row with `palette` and no runner is not offered in the palette (it is a command this screen cannot run now);
//    a row without `palette` is shown on the sheet only.
// 4. Nothing here handles a key: the owner of the keyboard layer does, and its row here only describes it.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { CommandPaletteItem } from '../command-palette/command-filter';
import type { ShortcutGroup } from '../keyboard-shortcuts/ShortcutSheet';
import type { CoachedCommand } from './shortcut-coaching';

/** One command of a screen. */
export interface CommandRow {
  readonly id: string;
  readonly title: string;
  /** The keys that run it, as tokens (`mod`, `shift`, `G`); several combinations are listed in `keys` as one sequence. */
  readonly keys?: readonly string[];
  /** Other words that find it in the palette (never shown). */
  readonly aliases?: readonly string[];
  /** Where it stands among rows a query matches, higher first. */
  readonly score?: number;
  /** Offered in the palette: the section it files under, its icon and, when the palette's words differ, its label. */
  readonly palette?: { readonly section: string; readonly icon: string; readonly label?: string };
}

export interface CommandGroup { readonly heading: string; readonly rows: readonly CommandRow[] }

export interface CommandTable {
  /** The glyph each key token is drawn with; a token not listed is drawn as written. */
  readonly glyphs: Readonly<Record<string, string>>;
  readonly groups: readonly CommandGroup[];
}

/** The display tokens of a row's keys, in order. */
export const keyTokens = (table: CommandTable, row: CommandRow): string[] => (row.keys ?? []).map(token => table.glyphs[token] ?? token);

/** The keys as one line of text ("⌘K"), as a palette hint and a tip name them. */
export const keysOf = (table: CommandTable, row: CommandRow): string => keyTokens(table, row).join('');

/** Every row of the table, in order. */
export const rowsOf = (table: CommandTable): CommandRow[] => table.groups.flatMap(group => [...group.rows]);

/** One row by its id. */
export const rowById = (table: CommandTable, id: string): CommandRow | undefined => rowsOf(table).find(row => row.id === id);

/** The shortcut sheet's groups: every row that has keys, under its group's heading. */
export function shortcutGroups(table: CommandTable): ShortcutGroup[] {
  return table.groups
    .map(group => ({ heading: group.heading, rows: group.rows.filter(row => row.keys?.length).map(row => ({ label: row.title, keys: keyTokens(table, row) })) }))
    .filter(group => group.rows.length);
}

/**
 * The palette's rows: each row of the table that asks for the palette and has a runner. `command` names the row so the
 * caller can tell which command was chosen (to coach its keys); the keys are the row's hint.
 */
export function paletteItems(table: CommandTable, runners: Readonly<Record<string, () => void>>): Array<CommandPaletteItem & { readonly command: string }> {
  return rowsOf(table).flatMap(row => {
    const run = runners[row.id];
    if (!row.palette || typeof run !== 'function') return [];
    return [{
      id: `cmd-${row.id}`, command: row.id, label: row.palette.label ?? row.title, icon: row.palette.icon, section: row.palette.section,
      ...(row.keys?.length ? { hint: keysOf(table, row) } : {}),
      ...(row.aliases?.length ? { aliases: row.aliases } : {}),
      ...(typeof row.score === 'number' ? { score: row.score } : {}),
      run,
    }];
  });
}

/** The command a tip is about, for the row with this id (undefined when the table has no such row or it has no keys). */
export function coachedCommand(table: CommandTable, id: string | undefined): CoachedCommand | undefined {
  const row = id === undefined ? undefined : rowById(table, id);
  return row?.keys?.length ? { id: row.id, title: row.title, keys: keysOf(table, row) } : undefined;
}
