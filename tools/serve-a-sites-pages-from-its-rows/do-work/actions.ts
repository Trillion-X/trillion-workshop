// tools/serve-a-sites-pages-from-its-rows/do-work/actions.ts
//
// PURPOSE
//   A site's actions as rows: a form or a script on a page posts to an address, and the row for that address names the tool
//   that does the job, how the tool's input is made from what the request carries, and what the visitor gets back. A screen
//   part posts a plain form (or JSON) to the address; it holds no callback, and no program is written for one site's action.
//
//   An action row (the table named by settings.actions):
//     path      the address pattern, as a page's: "/checkout", "/book/:offer", "/book/offer:one" (a literal part may
//               hold a ':' after its first character)
//     host      the one host it answers on, or null for every host; a host's own row wins
//     access    "public" (anyone; run as the site, or as the member when one is signed in) or "members" (members only, run as
//               the member)
//     tool      the tool that does the job
//     input     jsonb: the tool's input; a value written { "$": "<source>", ... } is filled from the request (below)
//     answer    jsonb: { "redirect_from": "<key of the tool's answer>" }  the visitor is sent to that address
//                      { "redirect_to": <value> }                         the visitor is sent to that address
//                      { "json": ["<key>", ...] }                        those keys of the tool's answer, as JSON
//     failed    the words a visitor gets when the tool fails
//
//   A value's sources:
//     { "$": "body", "key": "a.b" }                 a field of the posted form or JSON body (a dotted key reads into JSON)
//     { "$": "path", "name": "offer" }              the value of the address's ":offer" part
//     { "$": "cookie", "name": "n", "when": { "cookie": "c", "is": "v" } }
//                                                   a cookie's value; with `when`, only while cookie c holds v (a consent)
//     { "$": "member", "claim": "email" }           a claim of the signed-in member's pass; nothing when signed out
//     { "$": "origin", "then": "/welcome" }         the request's own site address, then the words given
//     { "$": "rows", "sql": "SELECT ...", "params": [values], "database": "name" }
//                                                   the rows of a statement, run as the site, on the site's own pages database
//                                                   or the one named
//     { "$": "url", "base": <value>, "query": { "k": <value> } }
//                                                   an address with query values set; a value that is nothing is left out
//     { "$": "number", "of": <value> }              a value as a number; nothing when it is not one
//     { "$": "answer", "key": "a.b" }               a key of the tool's answer (only in answer.redirect_to)
//     { "$": "now" }                                the time now, as ISO 8601
//     { "$": "new_id" }                             a new random id
//     { "$": "first", "of": [<value>, ...] }        the first value that gives something (the page's attempt id, else a new one)
//     { "$": "boolean", "of": <value> }             true for true, "true", "on", "yes" or "1"; false for their opposites
//   A source that gives nothing leaves its key out of an object (null in a list), and an object all of whose values gave
//   nothing is itself nothing, so a tool's optional input stays absent (a signed-out buyer sends no customer) and its
//   required input is refused by the tool's own schema, never guessed. A body key is read whole first ("consent.billing"
//   as a form field's name), then dotted into JSON.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing about any one site is in this file: the rows are the site's actions.
//   2. A row that breaks a rule is set aside with its path and why; every source is checked when the row is read.
//   3. An address a visitor is sent to is an http(s) address or a path of this site; anything else is refused.
//   4. A request from another site's page (its Origin header names another host) is refused, so no other site posts here
//      as a signed-in member.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { randomUUID } from 'node:crypto';
import { HOST, isPathPattern, matchPage, PageRowError, TABLE, TOOL_ID } from './pages.ts';
import type { Matched, Refused } from './pages.ts';

export type ActionAnswer = { redirect_from: string } | { redirect_to: unknown } | { json: string[] };

export interface ActionRow {
  path: string;
  host: string | null;
  access: 'public' | 'members';
  tool: string;
  input: unknown;
  answer: ActionAnswer;
  failed: string;
}

/** What one request carries, for filling an action's input. */
export interface Asked {
  body: Record<string, unknown>;
  params: Record<string, string>;
  cookies: Record<string, string>;
  claims: Record<string, unknown> | null;
  origin: string;
  rows: (sql: string, params: unknown[], database?: string) => Promise<Record<string, unknown>[]>;
  /** The tool's answer, once the tool has answered (for answer.redirect_to); null while its input is made. */
  answer: Record<string, unknown> | null;
}

const SOURCES: Record<string, (value: Record<string, unknown>, where: string) => void> = {
  body: (v, where) => words(v.key, `${where}.key`),
  path: (v, where) => words(v.name, `${where}.name`),
  cookie: (v, where) => {
    words(v.name, `${where}.name`);
    if (v.when !== undefined) {
      const when = v.when as Record<string, unknown> | null;
      if (!when || typeof when !== 'object') throw new PageRowError(`${where}.when is { cookie, is }.`);
      words(when.cookie, `${where}.when.cookie`);
      words(when.is, `${where}.when.is`);
    }
  },
  member: (v, where) => words(v.claim, `${where}.claim`),
  origin: (v, where) => { if (v.then !== undefined && typeof v.then !== 'string') throw new PageRowError(`${where}.then is words.`); },
  rows: (v, where) => {
    words(v.sql, `${where}.sql`);
    if (v.database !== undefined && (typeof v.database !== 'string' || !TABLE.test(v.database))) throw new PageRowError(`${where}.database is a database name.`);
    if (v.params !== undefined && !Array.isArray(v.params)) throw new PageRowError(`${where}.params is a list.`);
    (v.params as unknown[] | undefined)?.forEach((param, i) => checkValue(param, `${where}.params[${i}]`));
  },
  url: (v, where) => {
    checkValue(v.base, `${where}.base`);
    if (v.query !== undefined && (!v.query || typeof v.query !== 'object' || Array.isArray(v.query))) throw new PageRowError(`${where}.query is an object.`);
    for (const [key, value] of Object.entries((v.query ?? {}) as Record<string, unknown>)) checkValue(value, `${where}.query.${key}`);
  },
  number: (v, where) => checkValue(v.of, `${where}.of`),
  boolean: (v, where) => checkValue(v.of, `${where}.of`),
  first: (v, where) => {
    if (!Array.isArray(v.of) || v.of.length === 0) throw new PageRowError(`${where}.of lists the values to try in order.`);
    v.of.forEach((item, i) => checkValue(item, `${where}.of[${i}]`));
  },
  answer: (v, where) => words(v.key, `${where}.key`),
  now: () => {},
  new_id: () => {},
};

function words(value: unknown, where: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new PageRowError(`${where} is words.`);
}

const isSource = (value: unknown): value is Record<string, unknown> & { $: string } =>
  !!value && typeof value === 'object' && !Array.isArray(value) && '$' in value;

/** Checks a value with its sources; a source that is not one of the list above throws. */
export function checkValue(value: unknown, where: string): void {
  if (isSource(value)) {
    const check = typeof value.$ === 'string' ? SOURCES[value.$] : undefined;
    if (!check) throw new PageRowError(`${where}: "$" is one of ${Object.keys(SOURCES).join(', ')}.`);
    check(value, where);
    return;
  }
  if (Array.isArray(value)) value.forEach((item, i) => checkValue(item, `${where}[${i}]`));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) checkValue(item, `${where}.${key}`);
}

/** One action row checked; a broken row throws with its path and why. */
export function actionOf(row: Record<string, unknown>): ActionRow {
  const path = row.path;
  if (!isPathPattern(path)) throw new PageRowError(`action ${JSON.stringify(path)}: path is "/" or "/" and parts of letters, digits, ._~- or ":name".`);
  const where = `action ${path}`;
  const host = row.host ?? null;
  if (host !== null && (typeof host !== 'string' || !HOST.test(host))) throw new PageRowError(`${where}: host is a lower-case host name or null.`);
  if (row.access !== 'public' && row.access !== 'members') throw new PageRowError(`${where}: access is "public" or "members".`);
  if (typeof row.tool !== 'string' || !TOOL_ID.test(row.tool)) throw new PageRowError(`${where}: tool is a tool id such as tool:start-a-checkout.`);
  checkValue(row.input ?? {}, `${where} input`);
  const answer = row.answer as Record<string, unknown> | null;
  const kinds = answer && typeof answer === 'object' ? Object.keys(answer) : [];
  if (kinds.length !== 1 || !['redirect_from', 'redirect_to', 'json'].includes(kinds[0])) {
    throw new PageRowError(`${where}: answer is { "redirect_from": key }, { "redirect_to": value } or { "json": [keys] }.`);
  }
  if ('redirect_from' in answer!) words(answer.redirect_from, `${where} answer.redirect_from`);
  if ('redirect_to' in answer!) checkValue(answer.redirect_to, `${where} answer.redirect_to`);
  if ('json' in answer! && (!Array.isArray(answer.json) || answer.json.length === 0 || answer.json.some(key => typeof key !== 'string' || !key))) {
    throw new PageRowError(`${where}: answer.json lists the answer's keys to send.`);
  }
  words(row.failed, `${where}: failed`);
  return { path, host: host as string | null, access: row.access, tool: row.tool, input: row.input ?? {}, answer: answer as ActionAnswer, failed: row.failed as string };
}

/** The checked rows, and the rows set aside with why; a second row for one address and host is set aside. */
export function actionsOf(rows: Record<string, unknown>[]): { actions: ActionRow[]; refused: Refused[] } {
  const actions: ActionRow[] = [];
  const refused: Refused[] = [];
  for (const row of rows) {
    try {
      const action = actionOf(row);
      if (actions.some(a => a.path === action.path && a.host === action.host)) throw new PageRowError(`action ${action.path}: a second row for the same address and host.`);
      actions.push(action);
    } catch (error) {
      if (!(error instanceof PageRowError)) throw error;
      refused.push({ path: String(row.path), why: error.message });
    }
  }
  return { actions, refused };
}

/** The sql that reads a site's action rows from its table. */
export function actionsSql(table: string): string {
  if (!TABLE.test(table)) throw new PageRowError(`actions ${JSON.stringify(table)} is not a table name.`);
  return `SELECT a.path, a.access, a.tool, a.input, a.answer, a.failed, to_jsonb(a)->>'host' AS host FROM "${table}" a ORDER BY 1, 7 NULLS LAST`;
}

/** The action a request's host and path are; a host's own row wins over a row for every host. */
export function matchAction(actions: ActionRow[], host: string, pathname: string): Matched<ActionRow> | null {
  const own = actions.filter(action => action.host === host);
  const taken = new Set(own.map(action => action.path));
  return matchPage([...own, ...actions.filter(action => action.host === null && !taken.has(action.path))], pathname);
}

/** A request's cookies by name (the first of a name wins). */
export function cookiesOf(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of String(header ?? '').split(';')) {
    const at = pair.indexOf('=');
    if (at < 1) continue;
    const name = pair.slice(0, at).trim();
    if (!(name in cookies)) {
      try { cookies[name] = decodeURIComponent(pair.slice(at + 1).trim()); } catch { cookies[name] = pair.slice(at + 1).trim(); }
    }
  }
  return cookies;
}

/** A posted body: JSON or a urlencoded form; anything else is refused. */
export function bodyOf(contentType: string | undefined, bytes: Buffer): { body: Record<string, unknown>; form: boolean } {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  const text = bytes.toString('utf8');
  if (type === 'application/x-www-form-urlencoded') return { body: Object.fromEntries(new URLSearchParams(text)), form: true };
  if (type === 'application/json' || (type === '' && text.trim() === '')) {
    const body = text.trim() ? JSON.parse(text) : {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SyntaxError('The body is not a JSON object.');
    return { body: body as Record<string, unknown>, form: false };
  }
  throw new SyntaxError('The body is a form (application/x-www-form-urlencoded) or JSON (application/json).');
}

const TRUE = new Set(['true', 'on', 'yes', '1']);
const FALSE = new Set(['false', 'off', 'no', '0']);

function dotted(value: unknown, key: string): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key)) return (value as Record<string, unknown>)[key];
  return key.split('.').reduce<unknown>((at, part) => (at && typeof at === 'object' && !Array.isArray(at) ? (at as Record<string, unknown>)[part] : undefined), value);
}

/** A value with every source filled from the request; a source that gives nothing is undefined. */
export async function filled(value: unknown, asked: Asked): Promise<unknown> {
  if (isSource(value)) {
    switch (value.$) {
      case 'body': return dotted(asked.body, value.key as string);
      case 'path': return asked.params[value.name as string];
      case 'cookie': {
        const when = value.when as { cookie: string; is: string } | undefined;
        if (when && asked.cookies[when.cookie] !== when.is) return undefined;
        return asked.cookies[value.name as string];
      }
      case 'member': return asked.claims ? asked.claims[value.claim as string] : undefined;
      case 'origin': return `${asked.origin}${(value.then as string | undefined) ?? ''}`;
      case 'rows': {
        const params = await Promise.all(((value.params ?? []) as unknown[]).map(async param => (await filled(param, asked)) ?? null));
        return asked.rows(value.sql as string, params, value.database as string | undefined);
      }
      case 'url': {
        const base = await filled(value.base, asked);
        if (typeof base !== 'string') return undefined;
        const url = new URL(base, asked.origin);
        for (const [key, item] of Object.entries((value.query ?? {}) as Record<string, unknown>)) {
          const got = await filled(item, asked);
          if (got !== undefined && got !== null && got !== '') url.searchParams.set(key, String(got));
        }
        return base.startsWith('/') ? `${url.pathname}${url.search}` : url.toString();
      }
      case 'number': {
        const got = await filled(value.of, asked);
        const number = typeof got === 'number' ? got : typeof got === 'string' && got.trim() ? Number(got) : NaN;
        return Number.isFinite(number) ? number : undefined;
      }
      case 'first': {
        for (const item of value.of as unknown[]) {
          const got = await filled(item, asked);
          if (got !== undefined && got !== null && got !== '') return got;
        }
        return undefined;
      }
      case 'boolean': {
        const got = await filled(value.of, asked);
        if (typeof got === 'boolean') return got;
        const word = typeof got === 'string' || typeof got === 'number' ? String(got).trim().toLowerCase() : '';
        return TRUE.has(word) ? true : FALSE.has(word) ? false : undefined;
      }
      case 'answer': return asked.answer ? dotted(asked.answer, value.key as string) : undefined;
      case 'now': return new Date().toISOString();
      case 'new_id': return randomUUID();
      default: throw new Error(`"$": ${JSON.stringify(value.$)} is not a source.`);
    }
  }
  if (Array.isArray(value)) return Promise.all(value.map(async item => (await filled(item, asked)) ?? null));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value);
    for (const [key, item] of entries) {
      const got = await filled(item, asked);
      if (got !== undefined && got !== null) out[key] = got;
    }
    return entries.length > 0 && Object.keys(out).length === 0 ? undefined : out;
  }
  return value;
}

/** An address a visitor may be sent to: an http(s) address, or a path of this site; else null. */
export function sendableAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (/^\/(?!\/)/.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}
