// tools/serve-a-sites-pages-from-its-rows/do-work/rights.ts
//
// PURPOSE
//   The rights a site's own door key needs, made from the site's published rows, never written by hand: exactly the tools the
//   site runs as itself, and for each tool exactly the names its rows give where that tool opens a held value (the database
//   whose login a row opens). It is the site's counterpart of what a workflow row's `runs` is to its steps
//   (tools/workflows/read-data/derived-records.mjs): a public page or action row that names a tool is the grant's reason for it.
//
//   The site runs as itself (its own door key, serve.ts `sitePass`):
//     - run-sql on settings.pages.database, under settings.pages.use: its pages, look and action rows and each collection's slugs
//     - settings.site_head, when it names one
//     - each settings.served_files rule's only_listed_by tool, with its input as written (served-files.ts)
//     - each public page's own tool and every tool node of its layout (render.ts treeOf and runsOf)
//     - each public action row's tool, its undo, its then, each of its next steps and their failed steps, and every
//       { "$": "tool" } and { "$": "rows" } source inside them and inside its answer (actions.ts),
//       for a visitor who is not signed in (a member's own pass runs it for a member)
//   A members page or a members action runs only with the member's own pass, so it adds nothing here.
//
//   derivedGrantOf(site, heldOf) answers { grant, refused }:
//     grant    { tools, identity: "none", journal: "input", held_inputs_by_tool: { TOOL: { INPUT_PATH: [text, ...] } } }:
//              the act grant the site's key is kept under (trillion-rust share_grant.rs Act), with its held inputs listed per
//              tool, so the database one tool may name is never a name another tool may give.
//     refused  [{ where, tool, why }]: each call the grant cannot let the site make as its rows say it, and why; the grant is
//              usable for the site only when this is empty. A call is refused when it
//                - gives a held name filled from the request (a path, query, body or other source), which no grant can list;
//                - gives a held name to a tool whose held value binds no use, which a share never opens by name, unless the
//                  mount marks it a plain key (`share_by_listing: true`, a Stripe key named by its vault name): then the grant
//                  lists that very name, as it lists a database;
//                - gives a held name with no use, where the tool's held value binds one (the site's rows declare their uses);
//                - runs SQL that is not a read through run-sql, which under a share opens the reader login and cannot write
//                  (a write is the declared write tool the row names).
//   heldOf(tool) answers [{ path, use_from_input }], or null for a tool this tree does not hold: where that tool's input names a
//   held value (its row's credential mounts' `secret_name_from_input`) and the input path its use comes from
//   (`under_use.use_from_input`, null when it binds none). heldInputsOfTools(toolsFolder) reads it from every what-this-tool-does-and-how-to-run-it.json.
//
//   Every call that names a database and no use is given settings.pages.use, as the site gives it (serve.ts withPagesUse).
//
//   With { actions: "pass_on" } (the reads mode, a site whose writes another program still makes), no action row is granted:
//   the answer's pass_on_exact lists each public action row as { path, host, method }, the exact pass_on entries that send
//   those addresses to that program (an exact entry beats an action row; a prefix does not), so the grant and the pass_on list
//   are made from the same rows and cannot disagree. An action whose path has a ":name" part cannot be passed on exactly and
//   is refused.
//
//   siteRowsOf(rows, { database, use, site }) reads a site's rows as its program reads them when its settings name its
//   site_settings row (site-settings.ts): that row (its use checked), the pages and the action table it names. A computer's
//   apply derives the act its row applies from them (tools/start-a-computer apply-a-computer-row.mjs, an act given as
//   { derive_from }), and grantDifference(applied, derived) says what a derived grant adds (widened: never applied without a
//   person) and drops (narrowed) against the one applied; askedBy names the rows that ask for each tool.
//
//   Run as `node do-work/rights.ts SETTINGS_FILE PAGES_FILE ACTIONS_FILE [--reads]`, with the rows as run-sql answers them (the
//   statements of pages.ts PAGES_SQL and actions.ts actionsSql), it prints { grant, refused } (and pass_on_exact with --reads).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing about any one site is in this file: the rows are the site's rights.
//   2. A tool is in the grant only when a row the site runs as itself names it; a held name only when a row gives it as written.
//   3. Nothing is widened to make a refused call fit: a refusal is listed, and the rows (or the tool) change.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { actionsOf, actionsSql } from './actions.ts';
import { PAGES_SQL, pagesOf } from './pages.ts';
import type { LayoutNode } from './pages.ts';
import { SITE_SETTINGS_SQL, siteSettingsOf } from './site-settings.ts';

const RUN_SQL = 'tool:run-sql-in-my-database';

export interface Held {
  path: string;
  use_from_input: string | null;
  /**
   * The held value is a plain key, not a database login (its mount says `share_by_listing: true`): a share's run opens it,
   * with no use, only when the grant lists that very name at this path (trillion-rust tools.rs held_name).
   */
  share_by_listing?: true;
}

type Fields = Record<string, unknown>;

export interface SiteRows {
  settings: { pages: { database: string; use?: unknown }; site_head?: { tool: string; input: Fields }; served_files?: { only_listed_by?: { tool: string; input: Fields } }[] };
  pages: Fields[];
  actions: Fields[];
}

export interface Refusal {
  where: string;
  tool: string;
  why: string;
}

export interface DerivedGrant {
  grant: { tools: string[]; identity: 'none'; journal: 'input'; held_inputs_by_tool: Record<string, Record<string, string[]>> };
  refused: Refusal[];
  /** With { actions: "pass_on" }: the exact pass_on entries for the public action rows. */
  pass_on_exact?: { path: string; host: string | null; method: string }[];
}

export interface DeriveOptions {
  /** "run" (the default): the action rows' calls are granted; "pass_on": they are passed on exactly instead. */
  actions?: 'run' | 'pass_on';
}

interface Call {
  where: string;
  tool: string;
  input: unknown;
}

const object = (value: unknown): value is Fields => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function at(input: unknown, path: string): unknown {
  let value = input;
  for (const key of path.split('.')) value = object(value) ? value[key] : undefined;
  return value;
}

// A source (actions.ts) or a page's ":name" / ":query.key" string is filled from the request, so it names nothing a grant can list.
const fromRequest = (value: unknown): boolean => (object(value) && typeof value.$ === 'string') || (typeof value === 'string' && value.startsWith(':'));

// A read starts as one and holds no writing word anywhere, so a WITH whose part updates ("WITH s AS (UPDATE ...)") is a write.
const READ_START = /^\s*(\(\s*)*(select|with|values|table)\b/i;
const WRITE_WORD = /\b(insert|update|delete|merge|truncate|copy|lock)\b/i;
const isRead = (sql: string): boolean => READ_START.test(sql) && !WRITE_WORD.test(sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "''"));

/** Every { "$": "tool" } and { "$": "rows" } source inside a value, as the calls they make. */
function sourceCallsOf(value: unknown, where: string, database: string, use: unknown): Call[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => sourceCallsOf(item, `${where}[${i}]`, database, use));
  if (!object(value)) return [];
  const inner = Object.entries(value).flatMap(([key, item]) => sourceCallsOf(item, `${where}.${key}`, database, use));
  if (value.$ === 'tool' && typeof value.tool === 'string') return [{ where, tool: value.tool, input: value.input ?? {} }, ...inner];
  if (value.$ === 'rows') {
    const sql = typeof value.sql === 'string' ? value.sql : '';
    return [{ where, tool: RUN_SQL, input: { database: value.database ?? database, sql, ...(use === undefined ? {} : { use }) } }, ...inner];
  }
  return inner;
}

/** Every tool node of a layout. */
function layoutToolsOf(node: LayoutNode | null, where: string): Call[] {
  if (!node) return [];
  if ('tool' in node) return [{ where, tool: node.tool, input: node.input ?? {} }];
  if ('nodes' in node) return node.nodes.flatMap((child, i) => layoutToolsOf(child, `${where}.nodes[${i}]`));
  if ('children' in node) return (node.children ?? []).flatMap((child, i) => layoutToolsOf(child, `${where}.children[${i}]`));
  return [];
}

/** Every call the site makes with its own key, from its settings and its public rows. */
export function siteCallsOf({ settings, pages, actions }: SiteRows, { actions: actionMode = 'run' }: DeriveOptions = {}): { calls: Call[]; refused: Refusal[]; pass_on_exact: { path: string; host: string | null; method: string }[] } {
  const { database, use } = settings.pages;
  const passOnExact: { path: string; host: string | null; method: string }[] = [];
  const calls: Call[] = [{ where: 'settings.pages', tool: RUN_SQL, input: { database, sql: 'SELECT', ...(use === undefined ? {} : { use }) } }];
  if (settings.site_head) calls.push({ where: 'settings.site_head', tool: settings.site_head.tool, input: settings.site_head.input });
  (settings.served_files ?? []).forEach((rule, i) => {
    if (rule.only_listed_by) calls.push({ where: `settings.served_files[${i}].only_listed_by`, tool: rule.only_listed_by.tool, input: rule.only_listed_by.input });
  });
  const read = pagesOf(pages);
  const done = actionsOf(actions);
  const refused: Refusal[] = [...read.refused, ...done.refused].map(({ path, why }) => ({ where: path, tool: '', why: `row set aside: ${why}` }));
  for (const page of read.pages.filter(row => row.access === 'public')) {
    const where = `page ${page.path}`;
    if (page.tool) calls.push({ where, tool: page.tool, input: page.input ?? {} });
    calls.push(...layoutToolsOf(page.layout, `${where} layout`));
  }
  for (const action of done.actions.filter(row => row.access === 'public')) {
    const where = `action ${action.method} ${action.path}`;
    if (actionMode === 'pass_on') {
      if (action.path.split('/').some(part => part.startsWith(':'))) refused.push({ where, tool: action.tool, why: 'its path has a :name part, so no exact pass_on entry can send it on' });
      else if (!passOnExact.some(entry => entry.path === action.path && entry.host === action.host && entry.method === action.method)) passOnExact.push({ path: action.path, host: action.host, method: action.method });
      continue;
    }
    calls.push({ where, tool: action.tool, input: action.input }, ...sourceCallsOf(action.input, `${where} input`, database, use));
    // Every step the row runs beside its own tool is a call the site makes: its undo, its then, each next step and its failed
    // step, and the tool and rows sources inside them and inside the answer (a reply's status or headers, a redirect_to).
    const steps: [string, { tool: string; input: unknown } | null][] = [
      ['undo', action.undo], ['then', action.then],
      ...action.next.flatMap((step, i): [string, { tool: string; input: unknown } | null][] => [[`next[${i}]`, step], [`next[${i}].failed`, step.failed]]),
    ];
    for (const [name, step] of steps) if (step) calls.push({ where: `${where} ${name}`, tool: step.tool, input: step.input }, ...sourceCallsOf(step.input, `${where} ${name}.input`, database, use));
    action.next.forEach((step, i) => calls.push(...sourceCallsOf(step.when, `${where} next[${i}].when`, database, use)));
    calls.push(...sourceCallsOf(action.answer, `${where} answer`, database, use));
  }
  // The site gives the pages' use to every call that names a database and no use (serve.ts withPagesUse).
  const given = calls.map(call => (use !== undefined && object(call.input) && typeof call.input.database === 'string' && call.input.use === undefined
    ? { ...call, input: { ...call.input, use } } : call));
  return { calls: given, refused, pass_on_exact: passOnExact };
}

/** The grant the site's key needs, made from its rows, and every call it cannot make as written. */
export function derivedGrantOf(site: SiteRows, heldOf: (tool: string) => Held[] | null, options: DeriveOptions = {}): DerivedGrant {
  const { calls, refused, pass_on_exact } = siteCallsOf(site, options);
  const tools = new Set<string>();
  const held: Record<string, Record<string, Set<string>>> = {};
  for (const { where, tool, input } of calls) {
    const items = heldOf(tool);
    if (items === null) { refused.push({ where, tool, why: 'this tools folder holds no row for the tool' }); continue; }
    tools.add(tool);
    for (const { path, use_from_input, share_by_listing } of items) {
      const given = at(input, path);
      if (given === undefined || given === null) continue;
      const why = fromRequest(given) ? `its held input ${path} is filled from the request, and a grant lists only names written in the row`
        : typeof given !== 'string' || !given ? `its held input ${path} is not a name`
        : use_from_input === null && !share_by_listing ? `it names a held value at ${path}, which binds no use, so a share never opens it by name`
        : use_from_input === null ? null
        : at(input, use_from_input) === undefined ? `it names ${given} at ${path} with no ${use_from_input}: the row declares no use, and a share opens a database only under one`
        : null;
      if (why) { refused.push({ where, tool, why }); continue; }
      ((held[tool] ??= {})[path] ??= new Set()).add(given as string);
    }
    if (tool === RUN_SQL && object(input) && typeof input.sql === 'string' && !isRead(input.sql)) {
      refused.push({ where, tool, why: 'its SQL is not a read: under a share run-sql opens the reader login, so a write is the declared write tool the row names' });
    }
    if (tool === RUN_SQL && object(input) && Array.isArray(input.statements)) {
      refused.push({ where, tool, why: 'it runs statements: under a share run-sql opens the reader login, so a write is the declared write tool the row names' });
    }
  }
  const sorted = [...tools].sort();
  const byTool = Object.fromEntries(Object.keys(held).sort().map(tool => [tool,
    Object.fromEntries(Object.keys(held[tool]).sort().map(path => [path, [...held[tool][path]].sort()]))]));
  return { grant: { tools: sorted, identity: 'none', journal: 'input', held_inputs_by_tool: byTool }, refused, ...(options.actions === 'pass_on' ? { pass_on_exact } : {}) };
}

/** Runs one statement on the site's pages database and answers its rows. */
export type RowsOf = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

/** Where a site's rows are: its pages database, the use they are read under, and its name in the site_settings table. */
export interface SiteRowsAt {
  database: string;
  use: { purpose: string; surface: string };
  site: string;
}

/** A site's rows as its program reads them: its settings row (site-settings.ts), its pages and its action rows. */
export async function siteRowsOf(rows: RowsOf, at: SiteRowsAt): Promise<SiteRows> {
  const own = siteSettingsOf(await rows(SITE_SETTINGS_SQL, [at.site]), at.site, at.use);
  const [pages, actions] = await Promise.all([rows(PAGES_SQL, []), own.actions ? rows(actionsSql(own.actions), []) : []]);
  return {
    settings: { pages: { database: at.database, use: at.use }, ...(own.site_head ? { site_head: own.site_head } : {}), served_files: own.served_files },
    pages, actions,
  };
}

export type Grant = DerivedGrant['grant'];

export interface GrantDifference {
  /** True when the two grants let the site do exactly the same. */
  same: boolean;
  /** What the derived grant lets the site do that the applied one does not: tools, and held names by tool and input path. */
  widened: { tools: string[]; held: { tool: string; path: string; name: string }[]; other: string[] };
  /** What the applied grant lets the site do that the derived one no longer asks for. */
  narrowed: { tools: string[]; held: { tool: string; path: string; name: string }[] };
}

/**
 * How a grant derived from the rows differs from the one applied. A change of identity or journal is counted as widening
 * (`other`), never as narrowing, so it is never applied without a person.
 */
export function grantDifference(applied: Grant | null, derived: Grant): GrantDifference {
  const heldOf = (grant: Grant | null) => Object.entries(grant?.held_inputs_by_tool ?? {})
    .flatMap(([tool, paths]) => Object.entries(paths).flatMap(([path, names]) => names.map(name => ({ tool, path, name }))));
  const key = (item: { tool: string; path: string; name: string }) => JSON.stringify([item.tool, item.path, item.name]);
  const appliedTools = new Set(applied?.tools ?? []), derivedTools = new Set(derived.tools);
  const appliedHeld = new Map(heldOf(applied).map(item => [key(item), item])), derivedHeld = new Map(heldOf(derived).map(item => [key(item), item]));
  const other = [
    ...(applied?.identity !== derived.identity ? [`identity ${JSON.stringify(applied?.identity ?? null)} becomes ${JSON.stringify(derived.identity)}`] : []),
    ...(applied?.journal !== derived.journal ? [`journal ${JSON.stringify(applied?.journal ?? null)} becomes ${JSON.stringify(derived.journal)}`] : []),
  ];
  const widened = { tools: derived.tools.filter(tool => !appliedTools.has(tool)), held: [...derivedHeld].filter(([k]) => !appliedHeld.has(k)).map(([, item]) => item), other };
  const narrowed = { tools: [...appliedTools].filter(tool => !derivedTools.has(tool)).sort(), held: [...appliedHeld].filter(([k]) => !derivedHeld.has(k)).map(([, item]) => item) };
  const same = !widened.tools.length && !widened.held.length && !other.length && !narrowed.tools.length && !narrowed.held.length;
  return { same, widened, narrowed };
}

/** For each tool, the rows that ask the site to run it (siteCallsOf's `where`), so a finding can name them. */
export function askedBy(site: SiteRows, tools: string[], options: DeriveOptions = {}): Record<string, string[]> {
  const { calls } = siteCallsOf(site, options);
  return Object.fromEntries(tools.map(tool => [tool, [...new Set(calls.filter(call => call.tool === tool).map(call => call.where))].sort()]));
}

/** Where each tool of a tools folder names a held value from its input, read from every tool folder's what-this-tool-does-and-how-to-run-it.json. */
export function heldInputsOfTools(toolsFolder: string): (tool: string) => Held[] | null {
  const byTool = new Map();
  for (const folder of readdirSync(toolsFolder)) {
    let rows: { records?: { payload?: Fields }[] };
    try { rows = JSON.parse(readFileSync(join(toolsFolder, folder, 'what-this-tool-does-and-how-to-run-it.json'), 'utf8')); } catch { continue; }
    for (const { payload } of rows.records ?? []) {
      if (!payload || typeof payload.id !== 'string') continue;
      const items: Held[] = [];
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) return value.forEach(walk);
        if (!object(value)) return;
        if (typeof value.secret_name_from_input === 'string') {
          const use = object(value.under_use) && typeof value.under_use.use_from_input === 'string' ? value.under_use.use_from_input : null;
          items.push({ path: value.secret_name_from_input, use_from_input: use, ...(use === null && value.share_by_listing === true ? { share_by_listing: true as const } : {}) });
        }
        Object.values(value).forEach(walk);
      };
      walk(payload.invoke);
      // A path some mount opens with no use, and does not mark as a plain key a grant may list, is one a share never opens by
      // name, whatever another mount binds.
      const paths = [...new Set(items.map(item => item.path))];
      byTool.set(payload.id, paths.map(path => items.find(item => item.path === path && item.use_from_input === null && !item.share_by_listing)
        ?? items.find(item => item.path === path && item.use_from_input === null) ?? items.find(item => item.path === path)));
    }
  }
  return tool => byTool.get(tool) ?? null;
}

const started = (() => { try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; } })();
if (started) {
  const [settingsFile, pagesFile, actionsFile, mode] = process.argv.slice(2);
  if (!settingsFile || !pagesFile || !actionsFile) {
    console.error('usage: node do-work/rights.ts SETTINGS_FILE PAGES_FILE ACTIONS_FILE [--reads]');
    process.exit(2);
  }
  const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
  const rowsOf = (answer: unknown): Fields[] => (Array.isArray(answer) ? answer : (answer as { rows: Fields[] }).rows);
  const answer = derivedGrantOf({ settings: read(settingsFile), pages: rowsOf(read(pagesFile)), actions: rowsOf(read(actionsFile)) },
    heldInputsOfTools(join(import.meta.dirname, '..', '..')), mode === '--reads' ? { actions: 'pass_on' } : {});
  console.log(JSON.stringify(answer, null, 2));
}
