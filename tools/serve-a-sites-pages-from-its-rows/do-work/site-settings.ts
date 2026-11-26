// tools/serve-a-sites-pages-from-its-rows/do-work/site-settings.ts
//
// PURPOSE
//   The part of a site's settings that says what the site runs as itself, kept as one row of its pages database instead of in
//   the program's settings file, so the program, the act its key is granted (rights.ts) and the check that finds a difference
//   between the two all read the same row. The settings file names the row (`pages.settings`: the site's name) and keeps only
//   what the program needs to reach it: the database and the use the rows are read under.
//
//   The row is the site's `runs` setting in the pages database's site_settings table, the table a site keeps its settings in,
//   one row per site and key (site, key, value json): site is the site's name, as the settings file's pages.settings names it,
//   key is "runs", and value is
//     use           { purpose, surface }, the use every read of the site's rows runs under; it must equal the settings
//                   file's pages.use, which reads this very row (a row that says another use is refused, never followed)
//     site_head     { tool, input } or absent: the tool whose answer { head, body_start } every page carries
//     served_files  the served_files rules (served-files.ts), or absent
//     actions       the table of the site's action rows (actions.ts), such as site_actions, or absent
//
// NON-NEGOTIABLE INVARIANTS
//   1. A row that breaks a rule is refused whole, with why; nothing of it is used.
//   2. The settings file and the row never both say one of these: a file that names a settings row and also gives site_head,
//      served_files or actions is refused at start.
//   3. Nothing about any one site is in this file.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { isDeepStrictEqual } from 'node:util';
import { servedFilesOf } from './served-files.ts';
import type { ServedFiles } from './served-files.ts';

/** The table of the site settings rows. */
export const SITE_SETTINGS_TABLE = 'site_settings';
/** The key of the setting that says what a site runs as itself. */
export const RUNS_KEY = 'runs';
/** The statement that reads one site's `runs` setting ($1: the site's name). */
export const SITE_SETTINGS_SQL = `SELECT value FROM ${SITE_SETTINGS_TABLE} WHERE site = $1 AND key = '${RUNS_KEY}'`;

export interface SiteHead {
  tool: string;
  input: Record<string, unknown>;
}

export interface SiteSettings {
  use: { purpose: string; surface: string } | undefined;
  site_head?: SiteHead;
  served_files: ServedFiles[];
  actions?: string;
}

const TABLE = /^[a-z_][a-z0-9_]*$/;
export const SITE_NAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/** A site_head setting, checked; a wrong one throws naming what it should be. */
export function siteHeadOf(value: unknown): SiteHead | undefined {
  if (value === undefined || value === null) return undefined;
  const head = value as Partial<SiteHead>;
  if (typeof head !== 'object' || typeof head.tool !== 'string' || !head.tool.startsWith('tool:') || !head.input || typeof head.input !== 'object' || Array.isArray(head.input)) {
    throw new Error('site_head is { tool: "tool:<id>", input: { ... } }: the tool whose answer { head, body_start } every page carries.');
  }
  return { tool: head.tool, input: head.input };
}

/** An actions setting, checked: a table name, or nothing. */
export function actionsTableOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !TABLE.test(value)) throw new Error('actions is the table name of the site\'s action rows, such as "site_actions".');
  return value;
}

/** One site's settings row, checked against the use its rows are read under; a broken row throws with why. */
export function siteSettingsOf(rows: Record<string, unknown>[], site: string, use: SiteSettings['use']): SiteSettings {
  if (rows.length !== 1) throw new Error(`${SITE_SETTINGS_TABLE} holds ${rows.length} ${RUNS_KEY} rows for the site ${site}; it holds exactly one.`);
  const parse = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);
  const row = parse(rows[0].value) as Record<string, unknown> | null;
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['use', 'site_head', 'served_files', 'actions'].includes(key))) {
    throw new Error(`${SITE_SETTINGS_TABLE} ${site} ${RUNS_KEY}: its value is { use, site_head?, served_files?, actions? }.`);
  }
  const rowUse = parse(row.use) ?? undefined;
  if (!isDeepStrictEqual(rowUse, use)) {
    throw new Error(`${SITE_SETTINGS_TABLE} ${site}: its use ${JSON.stringify(rowUse ?? null)} is not the use its rows are read under (${JSON.stringify(use ?? null)}).`);
  }
  try {
    const head = siteHeadOf(parse(row.site_head));
    const actions = actionsTableOf(row.actions);
    return { use, ...(head ? { site_head: head } : {}), served_files: servedFilesOf(parse(row.served_files) ?? undefined), ...(actions ? { actions } : {}) };
  } catch (error) {
    throw new Error(`${SITE_SETTINGS_TABLE} ${site}: ${(error as Error).message}`);
  }
}
