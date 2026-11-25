// tools/serve-a-sites-pages-from-its-rows/do-work/pages.ts
//
// PURPOSE
//   A site's pages are rows of one `pages` table in the site's own database, read through the engine's door as the site's caller
//   (tool:run-sql-in-my-database with the declared use, so the computer opens the database with its reader login). This file
//   reads them, checks each, and matches a request's path to one page and the values its pattern takes.
//
//   One row is one page:
//     path        the address pattern: "/", "/articles", "/courses/:slug" (a ":name" part takes one path part)
//     title       the page's title
//     access      "public" or "members"
//     layout      the page's tree of parts (LayoutNode below), or null when the page is only its tool's screen
//     tool        the tool whose screen is the page's main screen (a template page), or null
//     input       that tool's input; a string value ":name" takes the path's value for :name
//     collection  for a template page: the table of the same database whose `slug` column lists its addresses (the sitemap)
//     updated_at  when the row last changed (the sitemap's lastmod)
//     host        the one host name the page answers on, or null for every host the site answers
//
//   A layout node is one of:
//     { "part": "<folder under tools>/show/.../<File>.tsx", "export": "<Name>", "props": {...}, "children": [node...] }
//     { "tool": "tool:<id>", "input": {...} }   that tool's screen, drawn with its answer
//     { "main": true }                          the page row's own tool screen
//     { "text": "..." }                         words
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing about any one site is in this file: the table's rows are the site.
//   2. A row that breaks a rule above is refused with its path and why, never served half right.
//   3. A part names a screen file inside the tools folder (a `show/` file, .tsx or .ts, no `..`), so a row can never place a
//      program that is not a screen.
//   4. A literal path part beats a ":name" part, so "/courses/new" is never taken by "/courses/:slug".
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export type Access = 'public' | 'members';

export type LayoutNode =
  | { part: string; export?: string; props?: Record<string, unknown>; children?: LayoutNode[] }
  | { tool: string; input?: unknown }
  | { main: true }
  | { text: string };

export interface PageRow {
  path: string;
  title: string;
  access: Access;
  layout: LayoutNode | null;
  tool: string | null;
  input: unknown;
  collection: string | null;
  updated_at: string | null;
  host: string | null;
}

export interface Matched {
  page: PageRow;
  params: Record<string, string>;
}

export class PageRowError extends Error {}

const PART_FILE = /^[a-z0-9][a-z0-9-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*\/show(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*\/[A-Za-z0-9_-]+\.tsx?$/;
const EXPORT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOOL_ID = /^tool:[a-z0-9][a-z0-9-]*$/;
const PATH_PART = /^(?::[a-z_][a-z0-9_]*|[A-Za-z0-9._~-]+)$/;
const TABLE = /^[a-z_][a-z0-9_]*$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** The SQL that reads every page row, with the columns this file reads, in one statement. */
export const PAGES_SQL = 'SELECT path, title, access, layout, tool, input, collection, updated_at::text AS updated_at, host FROM pages ORDER BY path, host NULLS LAST';

function checkNode(node: unknown, where: string, hasTool: boolean): LayoutNode {
  const n = node as Record<string, unknown> | null;
  if (!n || typeof n !== 'object' || Array.isArray(n)) throw new PageRowError(`${where}: a layout node is an object.`);
  if ('text' in n) {
    if (typeof n.text !== 'string') throw new PageRowError(`${where}: text is words.`);
    return { text: n.text };
  }
  if ('main' in n) {
    if (n.main !== true || !hasTool) throw new PageRowError(`${where}: {"main": true} stands only in a page whose row names a tool.`);
    return { main: true };
  }
  if ('tool' in n) {
    if (typeof n.tool !== 'string' || !TOOL_ID.test(n.tool)) throw new PageRowError(`${where}: tool is a tool id such as tool:read-the-courses.`);
    return { tool: n.tool, input: n.input ?? {} };
  }
  if (typeof n.part !== 'string' || !PART_FILE.test(n.part) || n.part.split('/').includes('..')) {
    throw new PageRowError(`${where}: part is a screen file under the tools folder, such as ui/show/pricing/Pricing.tsx.`);
  }
  const name = n.export ?? 'View';
  if (typeof name !== 'string' || !EXPORT_NAME.test(name)) throw new PageRowError(`${where}: export is the name the part's file exports.`);
  if (n.props !== undefined && (typeof n.props !== 'object' || n.props === null || Array.isArray(n.props))) throw new PageRowError(`${where}: props is an object.`);
  if (n.children !== undefined && !Array.isArray(n.children)) throw new PageRowError(`${where}: children is a list of nodes.`);
  const children = (n.children as unknown[] | undefined)?.map((child, i) => checkNode(child, `${where}.children[${i}]`, hasTool));
  return { part: n.part, export: name, ...(n.props ? { props: n.props as Record<string, unknown> } : {}), ...(children ? { children } : {}) };
}

/** One row checked against the rules above; a broken row throws with its path and why. */
export function pageOf(row: Record<string, unknown>): PageRow {
  const path = row.path;
  if (typeof path !== 'string' || !path.startsWith('/') || (path !== '/' && path.slice(1).split('/').some(part => !PATH_PART.test(part)))) {
    throw new PageRowError(`page ${JSON.stringify(path)}: path is "/" or "/" and parts of letters, digits, ._~- or ":name".`);
  }
  const where = `page ${path}`;
  if (typeof row.title !== 'string' || !row.title.trim()) throw new PageRowError(`${where}: title is words.`);
  if (row.access !== 'public' && row.access !== 'members') throw new PageRowError(`${where}: access is "public" or "members".`);
  const tool = row.tool ?? null;
  if (tool !== null && (typeof tool !== 'string' || !TOOL_ID.test(tool))) throw new PageRowError(`${where}: tool is a tool id or null.`);
  if (tool === null && (row.layout === null || row.layout === undefined)) throw new PageRowError(`${where}: a page has a layout, a tool, or both.`);
  const collection = row.collection ?? null;
  if (collection !== null && (typeof collection !== 'string' || !TABLE.test(collection))) throw new PageRowError(`${where}: collection is a table name or null.`);
  const host = row.host ?? null;
  if (host !== null && (typeof host !== 'string' || !HOST.test(host))) throw new PageRowError(`${where}: host is a lower-case host name or null.`);
  const params = paramsOf(path);
  for (const name of placeholdersIn(row.input)) {
    if (!params.includes(name)) throw new PageRowError(`${where}: input names ":${name}", which the path does not hold.`);
  }
  return {
    path,
    title: row.title,
    access: row.access,
    layout: row.layout === null || row.layout === undefined ? null : checkNode(row.layout, `${where} layout`, tool !== null),
    tool: tool as string | null,
    input: row.input ?? {},
    collection: collection as string | null,
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : null,
    host: host as string | null,
  };
}

/** Every row checked; the first broken row refuses the whole set, so a site never serves a set with a page missing. */
export function pagesOf(rows: Record<string, unknown>[]): PageRow[] {
  const pages = rows.map(pageOf);
  const seen = new Set<string>();
  for (const page of pages) {
    const shape = `${page.host ?? '*'} ${page.path.replace(/:[a-z_][a-z0-9_]*/g, ':')}`;
    if (seen.has(shape)) throw new PageRowError(`page ${page.path}: another row has the same address pattern on the same host.`);
    seen.add(shape);
  }
  return pages;
}

export function paramsOf(pattern: string): string[] {
  return pattern.split('/').filter(part => part.startsWith(':')).map(part => part.slice(1));
}

function placeholdersIn(value: unknown): string[] {
  if (typeof value === 'string') return /^:[a-z_][a-z0-9_]*$/.test(value) ? [value.slice(1)] : [];
  if (Array.isArray(value)) return value.flatMap(placeholdersIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(placeholdersIn);
  return [];
}

/** The input with each ":name" string replaced by the path's value for name. */
export function filledInput(input: unknown, params: Record<string, string>): unknown {
  if (typeof input === 'string') return /^:[a-z_][a-z0-9_]*$/.test(input) && input.slice(1) in params ? params[input.slice(1)] : input;
  if (Array.isArray(input)) return input.map(item => filledInput(item, params));
  if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, filledInput(value, params)]));
  return input;
}

/** The pages one host answers: its own rows, and the rows for every host whose address it has no own row for. */
export function pagesOn(pages: PageRow[], host: string): PageRow[] {
  const own = pages.filter(page => page.host === host);
  const taken = new Set(own.map(page => page.path));
  return [...own, ...pages.filter(page => page.host === null && !taken.has(page.path))];
}

/** The page a path is, and the values of its ":name" parts; a literal part beats a ":name" part. */
export function matchPage(pages: PageRow[], pathname: string): Matched | null {
  const asked = pathname === '/' ? [] : pathname.replace(/\/+$/, '').slice(1).split('/');
  let best: { matched: Matched; literals: number[] } | null = null;
  for (const page of pages) {
    const parts = page.path === '/' ? [] : page.path.slice(1).split('/');
    if (parts.length !== asked.length) continue;
    const params: Record<string, string> = {};
    const literals: number[] = [];
    let fits = true;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) {
        let value: string;
        try { value = decodeURIComponent(asked[i]); } catch { fits = false; break; }
        if (!value) { fits = false; break; }
        params[parts[i].slice(1)] = value;
        literals.push(0);
      } else if (parts[i] === asked[i]) {
        literals.push(1);
      } else {
        fits = false;
        break;
      }
    }
    if (!fits) continue;
    // Earlier literal parts weigh more: compare the literal marks left to right.
    if (!best || literals.join('') > best.literals.join('')) best = { matched: { page, params }, literals };
  }
  return best?.matched ?? null;
}

/** The sql that lists a template page's addresses: the `slug` column of its collection table. */
export function slugsSql(collection: string): string {
  if (!TABLE.test(collection)) throw new PageRowError(`collection ${JSON.stringify(collection)} is not a table name.`);
  return `SELECT slug FROM "${collection}" WHERE slug IS NOT NULL ORDER BY slug`;
}

/** A path with each ":name" part replaced by its value, each value made safe for an address. */
export function pathWith(pattern: string, params: Record<string, string>): string {
  return pattern.replace(/:([a-z_][a-z0-9_]*)/g, (_all, name: string) => encodeURIComponent(params[name] ?? ''));
}
