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
//     - each public page's own tool and every tool node of its layout (render.ts treeOf and runsOf)
//     - each public action row's tool, its undo, and every { "$": "tool" } and { "$": "rows" } source inside them (actions.ts),
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
//                - gives a held name to a tool whose held value binds no use, which a share never opens by name;
//                - gives a held name with no use, where the tool's held value binds one (the site's rows declare their uses);
//                - runs SQL that is not a read through run-sql, which under a share opens the reader login and cannot write
//                  (a write is the declared write tool the row names).
//   heldOf(tool) answers [{ path, use_from_input }], or null for a tool this tree does not hold: where that tool's input names a
//   held value (its row's credential mounts' `secret_name_from_input`) and the input path its use comes from
//   (`under_use.use_from_input`, null when it binds none). heldInputsOfTools(toolsFolder) reads it from every tool-rows.json.
//
//   Run as `node do-work/rights.ts SETTINGS_FILE PAGES_FILE ACTIONS_FILE`, with the rows as run-sql answers them (the
//   statements of pages.ts PAGES_SQL and actions.ts actionsSql), it prints { grant, refused }.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing about any one site is in this file: the rows are the site's rights.
//   2. A tool is in the grant only when a row the site runs as itself names it; a held name only when a row gives it as written.
//   3. Nothing is widened to make a refused call fit: a refusal is listed, and the rows (or the tool) change.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { actionsOf } from './actions.ts';
import { pagesOf } from './pages.ts';
import type { LayoutNode } from './pages.ts';

const RUN_SQL = 'tool:run-sql-in-my-database';

export interface Held {
  path: string;
  use_from_input: string | null;
}

type Fields = Record<string, unknown>;

export interface SiteRows {
  settings: { pages: { database: string; use?: unknown }; site_head?: { tool: string; input: Fields } };
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
export function siteCallsOf({ settings, pages, actions }: SiteRows): { calls: Call[]; refused: Refusal[] } {
  const { database, use } = settings.pages;
  const calls: Call[] = [{ where: 'settings.pages', tool: RUN_SQL, input: { database, sql: 'SELECT', ...(use === undefined ? {} : { use }) } }];
  if (settings.site_head) calls.push({ where: 'settings.site_head', tool: settings.site_head.tool, input: settings.site_head.input });
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
    calls.push({ where, tool: action.tool, input: action.input }, ...sourceCallsOf(action.input, `${where} input`, database, use));
    if (action.undo) calls.push({ where: `${where} undo`, tool: action.undo.tool, input: action.undo.input }, ...sourceCallsOf(action.undo.input, `${where} undo.input`, database, use));
  }
  return { calls, refused };
}

/** The grant the site's key needs, made from its rows, and every call it cannot make as written. */
export function derivedGrantOf(site: SiteRows, heldOf: (tool: string) => Held[] | null): DerivedGrant {
  const { calls, refused } = siteCallsOf(site);
  const tools = new Set<string>();
  const held: Record<string, Record<string, Set<string>>> = {};
  for (const { where, tool, input } of calls) {
    const items = heldOf(tool);
    if (items === null) { refused.push({ where, tool, why: 'this tools folder holds no row for the tool' }); continue; }
    tools.add(tool);
    for (const { path, use_from_input } of items) {
      const given = at(input, path);
      if (given === undefined || given === null) continue;
      const why = fromRequest(given) ? `its held input ${path} is filled from the request, and a grant lists only names written in the row`
        : typeof given !== 'string' || !given ? `its held input ${path} is not a name`
        : use_from_input === null ? `it names a held value at ${path}, which binds no use, so a share never opens it by name`
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
  return { grant: { tools: sorted, identity: 'none', journal: 'input', held_inputs_by_tool: byTool }, refused };
}

/** Where each tool of a tools folder names a held value from its input, read from every tool folder's tool-rows.json. */
export function heldInputsOfTools(toolsFolder: string): (tool: string) => Held[] | null {
  const byTool = new Map();
  for (const folder of readdirSync(toolsFolder)) {
    let rows: { records?: { payload?: Fields }[] };
    try { rows = JSON.parse(readFileSync(join(toolsFolder, folder, 'tool-rows.json'), 'utf8')); } catch { continue; }
    for (const { payload } of rows.records ?? []) {
      if (!payload || typeof payload.id !== 'string') continue;
      const items: Held[] = [];
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) return value.forEach(walk);
        if (!object(value)) return;
        if (typeof value.secret_name_from_input === 'string') {
          const use = object(value.under_use) && typeof value.under_use.use_from_input === 'string' ? value.under_use.use_from_input : null;
          items.push({ path: value.secret_name_from_input, use_from_input: use });
        }
        Object.values(value).forEach(walk);
      };
      walk(payload.invoke);
      // A path some mount opens with no use is one a share never opens by name, whatever another mount binds.
      const paths = [...new Set(items.map(item => item.path))];
      byTool.set(payload.id, paths.map(path => items.find(item => item.path === path && item.use_from_input === null) ?? items.find(item => item.path === path)));
    }
  }
  return tool => byTool.get(tool) ?? null;
}

const started = (() => { try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; } })();
if (started) {
  const [settingsFile, pagesFile, actionsFile] = process.argv.slice(2);
  if (!settingsFile || !pagesFile || !actionsFile) {
    console.error('usage: node do-work/rights.ts SETTINGS_FILE PAGES_FILE ACTIONS_FILE');
    process.exit(2);
  }
  const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
  const rowsOf = (answer: unknown): Fields[] => (Array.isArray(answer) ? answer : (answer as { rows: Fields[] }).rows);
  const answer = derivedGrantOf({ settings: read(settingsFile), pages: rowsOf(read(pagesFile)), actions: rowsOf(read(actionsFile)) },
    heldInputsOfTools(join(import.meta.dirname, '..', '..')));
  console.log(JSON.stringify(answer, null, 2));
}
