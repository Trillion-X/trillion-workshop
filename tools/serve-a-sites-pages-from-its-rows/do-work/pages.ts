// tools/serve-a-sites-pages-from-its-rows/do-work/pages.ts
//
// PURPOSE
//   A site's pages are rows of one `pages` table in the site's own database, read through the engine's door as the site's caller
//   (tool:run-sql-in-my-database with the declared use, so the computer opens the database with its reader login). This file
//   reads them, checks each, and matches a request's path to one page and the values its pattern takes.
//
//   One row is one page:
//     path        the address pattern: "/", "/articles", "/courses/:slug" (a ":name" part takes one path part)
//     title       the page's title; null for a template page, whose title is its main tool answer's `title`
//     access      "public" or "members"
//     layout      the page's tree of parts (LayoutNode below), or null when the page is only its tool's screen
//     tool        the tool whose screen is the page's main screen (a template page), or null
//     input       that tool's input; a string value ":name" takes the path's value for :name; a string ":query.key" takes the address's
//                 query value for key (left out when the address has none), so a page reads ?token= into a hidden field
//     collection  for a template page: the table of the same database whose `slug` column lists its addresses (the sitemap)
//     updated_at  when the row last changed (the sitemap's lastmod)
//     host        the one host name the page answers on, or null for every host the site answers
//
//   A layout is one node or a list of nodes (drawn one after another). A layout node is one of:
//     { "part": "<folder under tools>/show/.../<File>.tsx", "export": "<Name>", "props": {...}, "children": [node...] }
//     { "tool": "tool:<id>", "input": {...}, "props": {...} }   that tool's screen, drawn with its answer
//     { "tool": "tool:<id>", "input": {...}, "part": "...", "export": "<Name>", "props": {...} }
//                                               another screen file of the tools folder, drawn with that tool's answer
//                                               (a second look at the same answer, such as a carousel of the same pairs)
//     { "main": true, "props": {...} }          the page row's own tool screen
//   A screen's props are its tool's answer; a tool or main node's `props` are the page's own words the screen also takes
//   (a heading, a lede), under the answer, so a row never changes what the tool answered.
//     { "text": "..." }                         words
//     { "words": true }                         only in the not-found row (path NOT_FOUND, "/404"): where the tool places the
//                                               words of every page it draws without a page row (not found, not open to you,
//                                               could not be drawn, a form post that did not go through), so those pages
//                                               wear the site's own frame (its nav, its shell); the not-found row is then the
//                                               site's words page, and "There is no page at this address." fills it for a 404
//     { "go_to": "<address>" }                  the whole layout of a page that has moved: it answers 200 and the browser goes on
//                                               to that address (an http(s) address, or a path of this site); a
//                                               ":name" part in it takes the path's value, as in /articles/:slug
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
  | { tool: string; input?: unknown; part?: string; export?: string; props?: Record<string, unknown> }
  | { main: true; props?: Record<string, unknown> }
  | { text: string }
  | { words: true }
  | { nodes: LayoutNode[] }
  | { go_to: string };

/** The not-found row's path: drawn for an address no row answers, and, with a { "words": true } node, every words page. */
export const NOT_FOUND = '/404';

/** Whether a layout holds the { "words": true } place. */
export function hasWordsPlace(node: LayoutNode | null): boolean {
  if (!node) return false;
  if ('words' in node) return true;
  if ('nodes' in node) return node.nodes.some(hasWordsPlace);
  return 'children' in node && (node.children ?? []).some(hasWordsPlace);
}

export interface PageRow {
  path: string;
  title: string | null;
  access: Access;
  layout: LayoutNode | null;
  tool: string | null;
  input: unknown;
  collection: string | null;
  updated_at: string | null;
  host: string | null;
}

export interface Matched<T extends { path: string } = PageRow> {
  page: T;
  params: Record<string, string>;
}

export class PageRowError extends Error {}

const PART_FILE = /^[a-z0-9][a-z0-9-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*\/show(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*\/[A-Za-z0-9_-]+\.tsx?$/;
const EXPORT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const TOOL_ID = /^tool:[a-z0-9][a-z0-9-]*$/;
// A part is a ":name", or a literal of unreserved characters that may hold a ':' after its first character (an id such as
// offer:one is one literal part).
const PATH_PART = /^(?::[a-z_][a-z0-9_]*|[A-Za-z0-9._~-][A-Za-z0-9._~:-]*)$/;
export const TABLE = /^[a-z_][a-z0-9_]*$/;
export const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** The SQL that reads every page row, with the columns this file reads, in one statement. */
// `host` is read through the row's JSON, so a table made without the column reads every row as for every host.
export const PAGES_SQL = "SELECT p.path, p.title, p.access, p.layout, p.tool, p.input, p.collection, p.updated_at::text AS updated_at, to_jsonb(p)->>'host' AS host FROM pages p ORDER BY 1, 9 NULLS LAST";

function propsOf(props: unknown, where: string): { props?: Record<string, unknown> } {
  if (props === undefined || props === null) return {};
  if (typeof props !== 'object' || Array.isArray(props)) throw new PageRowError(`${where}: props is an object.`);
  return { props: props as Record<string, unknown> };
}

function partOf(part: unknown, where: string): string {
  if (typeof part !== 'string' || !PART_FILE.test(part) || part.split('/').includes('..')) {
    throw new PageRowError(`${where}: part is a screen file under the tools folder, such as ui/show/pricing/Pricing.tsx.`);
  }
  return part;
}

function exportOf(name: unknown, where: string): string {
  const given = name ?? 'View';
  if (typeof given !== 'string' || !EXPORT_NAME.test(given)) throw new PageRowError(`${where}: export is the name the part's file exports.`);
  return given;
}

function checkNode(node: unknown, where: string, hasTool: boolean, wordsPage: boolean): LayoutNode {
  if (Array.isArray(node)) return { nodes: node.map((child, i) => checkNode(child, `${where}[${i}]`, hasTool, wordsPage)) };
  const n = node as Record<string, unknown> | null;
  if (!n || typeof n !== 'object') throw new PageRowError(`${where}: a layout node is an object or a list of them.`);
  if ('go_to' in n) {
    if (where.endsWith(' layout') === false) throw new PageRowError(`${where}: go_to is a whole layout, never a part of one.`);
    if (typeof n.go_to !== 'string' || !/^(https?:\/\/[^\s"'<>]+|\/[^\s"'<>]*)$/.test(n.go_to)) throw new PageRowError(`${where}: go_to is an http(s) address or a path.`);
    return { go_to: n.go_to };
  }
  if ('text' in n) {
    if (typeof n.text !== 'string') throw new PageRowError(`${where}: text is words.`);
    return { text: n.text };
  }
  if ('words' in n) {
    if (n.words !== true || !wordsPage || Object.keys(n).length !== 1) throw new PageRowError(`${where}: {"words": true} stands alone, only in the ${NOT_FOUND} row.`);
    return { words: true };
  }
  if ('main' in n) {
    if (n.main !== true || !hasTool) throw new PageRowError(`${where}: {"main": true} stands only in a page whose row names a tool.`);
    return { main: true, ...propsOf(n.props, where) };
  }
  if ('tool' in n) {
    if (typeof n.tool !== 'string' || !TOOL_ID.test(n.tool)) throw new PageRowError(`${where}: tool is a tool id such as tool:read-the-courses.`);
    if (n.part === undefined) {
      if (n.export !== undefined) throw new PageRowError(`${where}: export names a part's export, and this tool node names no part.`);
      return { tool: n.tool, input: n.input ?? {}, ...propsOf(n.props, where) };
    }
    return { tool: n.tool, input: n.input ?? {}, part: partOf(n.part, where), export: exportOf(n.export, where), ...propsOf(n.props, where) };
  }
  const name = exportOf(n.export, where);
  const part = partOf(n.part, where);
  if (n.props !== undefined && (typeof n.props !== 'object' || n.props === null || Array.isArray(n.props))) throw new PageRowError(`${where}: props is an object.`);
  if (n.children !== undefined && !Array.isArray(n.children)) throw new PageRowError(`${where}: children is a list of nodes.`);
  const children = (n.children as unknown[] | undefined)?.map((child, i) => checkNode(child, `${where}.children[${i}]`, hasTool, wordsPage));
  return { part, export: name, ...(n.props ? { props: n.props as Record<string, unknown> } : {}), ...(children ? { children } : {}) };
}

/** One row checked against the rules above; a broken row throws with its path and why. */
export function pageOf(row: Record<string, unknown>): PageRow {
  const path = row.path;
  if (!isPathPattern(path)) {
    throw new PageRowError(`page ${JSON.stringify(path)}: path is "/" or "/" and parts of letters, digits, ._~- or ":name".`);
  }
  const where = `page ${path}`;
  const title = row.title ?? null;
  if (title === null ? row.tool === null || row.tool === undefined : typeof title !== 'string' || !title.trim()) {
    throw new PageRowError(`${where}: title is words, or null when the page's tool answers its title.`);
  }
  if (row.access !== 'public' && row.access !== 'members') throw new PageRowError(`${where}: access is "public" or "members".`);
  const tool = row.tool ?? null;
  if (tool !== null && (typeof tool !== 'string' || !TOOL_ID.test(tool))) throw new PageRowError(`${where}: tool is a tool id or null.`);
  const layout = row.layout === undefined || (Array.isArray(row.layout) && row.layout.length === 0) ? null : row.layout;
  if (tool === null && layout === null) throw new PageRowError(`${where}: a page has a layout, a tool, or both.`);
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
    title: title as string | null,
    access: row.access,
    layout: layout === null ? null : checkNode(layout, `${where} layout`, tool !== null, path === NOT_FOUND),
    tool: tool as string | null,
    input: row.input ?? {},
    collection: collection as string | null,
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : null,
    host: host as string | null,
  };
}

export interface Refused {
  path: string;
  why: string;
}

/**
 * Every row checked. A broken row is set aside with why, never served half right; its address answers "not ready" (serve.ts)
 * while every good row is served. A second row with the same pattern on the same host is set aside too.
 */
export function pagesOf(rows: Record<string, unknown>[]): { pages: PageRow[]; refused: Refused[] } {
  const pages: PageRow[] = [];
  const refused: Refused[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    try {
      const page = pageOf(row);
      const shape = `${page.host ?? '*'} ${page.path.replace(/:[a-z_][a-z0-9_]*/g, ':')}`;
      if (seen.has(shape)) throw new PageRowError(`page ${page.path}: another row has the same address pattern on the same host.`);
      seen.add(shape);
      pages.push(page);
    } catch (error) {
      if (!(error instanceof PageRowError)) throw error;
      refused.push({ path: typeof row.path === 'string' ? row.path : '', why: error.message });
    }
  }
  return { pages, refused };
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

const QUERY_VALUE = /^:query\.([A-Za-z0-9_.~-]+)$/;

/**
 * The input with each ":name" string replaced by the path's value for name, and each ":query.key" string by the address's
 * query value for key (a key the address does not carry leaves its object key out, and is null in a list).
 */
export function filledInput(input: unknown, params: Record<string, string>, query: URLSearchParams = new URLSearchParams()): unknown {
  if (typeof input === 'string') {
    const key = QUERY_VALUE.exec(input)?.[1];
    if (key !== undefined) return query.get(key) ?? undefined;
    return /^:[a-z_][a-z0-9_]*$/.test(input) && input.slice(1) in params ? params[input.slice(1)] : input;
  }
  if (Array.isArray(input)) return input.map(item => filledInput(item, params, query) ?? null);
  if (input && typeof input === 'object') {
    return Object.fromEntries(Object.entries(input).flatMap(([key, value]) => {
      const got = filledInput(value, params, query);
      return got === undefined ? [] : [[key, got]];
    }));
  }
  return input;
}

/** The pages one host answers: its own rows, and the rows for every host whose address it has no own row for. */
export function pagesOn(pages: PageRow[], host: string): PageRow[] {
  const own = pages.filter(page => page.host === host);
  const taken = new Set(own.map(page => page.path));
  return [...own, ...pages.filter(page => page.host === null && !taken.has(page.path))];
}

const safeDecode = (part: string): string | null => { try { return decodeURIComponent(part); } catch { return null; } };

/** A path pattern: "/" or "/" parts each a literal or a ":name". */
export function isPathPattern(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith('/') && (path === '/' || path.slice(1).split('/').every(part => PATH_PART.test(part)));
}

/** The row a path is (a page, an action), and the values of its ":name" parts; a literal part beats a ":name" part. */
export function matchPage<T extends { path: string }>(pages: T[], pathname: string): Matched<T> | null {
  const asked = pathname === '/' ? [] : pathname.replace(/\/+$/, '').slice(1).split('/');
  let best: { matched: Matched<T>; literals: number[] } | null = null;
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
      } else if (parts[i] === asked[i] || parts[i] === safeDecode(asked[i])) {
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
