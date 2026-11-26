// tools/serve-a-sites-pages-from-its-rows/do-work/serve.ts
//
// PURPOSE
//   One kept-running program serves a whole site from its rows: `node do-work/serve.ts <settings.json>`. Its computer row runs
//   it as a unit behind the computer's front web server (tool:start-a-computer), which passes it the site's requests on the
//   socket or port the settings name. For each request it answers, in this order:
//     /screen-files/<identity>.<js|css>   a page's mount script or stylesheet (screen-files.ts)
//     <member_files.path><key>            a member's file: 302 to a presigned link, for members only (member-video.ts)
//     a path under public_files.paths     a public file: 302 to a presigned link, cached (member-video.ts)
//     /sitemap.xml                        every public page address, template pages listed from their collection
//     a page row's address                the page (pages.ts, render.ts); a members page only for a member
//     a POST (or a GET) to an action row's address   that action's tool, its input made from the request, and its answer (actions.ts)
//   and the page row "/404" (or plain words) for any other address. Its pages, look and tool answers are read through the
//   engine's door (door.ts) as a caller: the site's own pass for public pages, the member's own pass for members pages.
//
//   Settings (one JSON file, made by the computer row; nothing secret in it):
//     listen         "unix:/run/<unit>/site.sock" or "127.0.0.1:<port>", or a list of them (one socket per host name when the
//                    front web server routes each name to its own socket); 127.0.0.1:18440 when left out (a local run)
//     origin         the site's address, such as https://example.com (canonical addresses, the sitemap)
//     hosts          (optional) the other host names one unit answers, such as ["app.example.com"]: a request's host is its
//                    X-Forwarded-Host when the front web server sets it, else its Host; its pages are the rows for that host
//                    and the rows for every host (pages.ts host); an unknown host is answered as origin's
//     lang           the pages' language, such as "en"
//     door           { address, pass_credential, pins }: the engine door, and the name of the site's pass in the unit's
//                    credentials; or address "cli:<command>": that computer's own command runs each read (door-op, with
//                    the pins given), as the computer's owner, and no pass is held. On a computer with no Mac app door
//                    (a Linux server) give it origin (its engine, such as http://127.0.0.1:7190) and key_credential (the
//                    name of the owner's key in the unit's credentials, handed to the command in its {CLI}_KEY). A members
//                    page is never drawn through a command: it needs the member's own pass on the door. Or { address: "unix:<the
//                    engine's vault socket>", peer: true }: the engine knows the caller by its OS user (the computer row's
//                    vault_readers row for this uid, whose act names the tools it may run), so no pass is held; a members page
//                    is never drawn through it either.
//     pages          { database, use: { purpose, surface }, refresh_seconds, answer_seconds }: the database holding the
//                    `pages` and `site_look` tables, the declared use its reads run under (the reader login; left out, the
//                    caller's own login, which only a local run through a command should do), how often the front asks
//                    whether its rows changed, and how long a public page's tool answer is kept. Each kind of row (the
//                    settings row, pages, look, actions, each collection's slugs) is kept until a change names its table:
//                    every refresh_seconds one statement (CHANGES_SQL) reads the database's row_changes for the tables
//                    changed since the last ask, and only those kinds are read again. A table whose changes row_changes
//                    does not tell (no tell_row_change trigger on it), or a database whose row_changes this login cannot
//                    read, is read again every refresh_seconds, as before; a view itself reads no row. The use is also given to every tool
//                    run whose input names a database and no use (withPagesUse), so a row's tool opens its database under it.
//                    With `settings` (the site's name), the site's runs row of site_settings (site-settings.ts) says site_head,
//                    served_files and actions instead of this file, read again with the rows; its use must be this use
//     sign_in        { address, page, issuer, audience, team_claim, members_team }: the site's sign-in tool, the site path a
//                    visitor is sent to for a members page, and how a member's pass is checked (member-pass.ts);
//                    signed_out "redirect" (302 to page?next=<address>, when left out) or "draw" (the page row at `page` is
//                    drawn at the members address itself, 200, private, no-store)
//     pass_on        [{ name, address, paths, exact, hosts, first }]: other programs that answer some of the site's addresses
//                    themselves (the sign-in tool's pages and /api/auth; a program's actions that have no tool yet): a request
//                    under one of `paths`, or at one of `exact`, on one of `hosts` (every host when left out), is passed to
//                    `address` whole, its answer passed back whole; the first entry that takes it wins. A path at one of
//                    `exact`, or under the `paths` of an entry with first: true, is passed on before any action or page row
//                    of the site's own (so a site can keep rows it does not answer yet); under other `paths` the site's own
//                    action rows and its longer page rows answer instead. `address` "named:<name>" is the one `addresses`
//                    names, so the computer's own setup fills one place in. With stream: true an entry is piped both ways
//                    as it comes, every header unchanged (an MCP door's event stream), never with site_head
//     addresses      (optional) { <name>: address }: addresses pass_on entries name as "named:<name>"
//     actions        (optional) the table of the site's action rows (actions.ts), read with the pages
//     address_cookies (optional) [{ query, cookie, pattern, upper_case, max_age_days, domain, http_only }]: values a visitor's
//                    arrival address carries (?ref=CODE) kept as cookies by any GET, the site's own pages and passed-on
//                    ones alike, when the value is the whole of its pattern (address-cookies.ts)
//     site_head      (optional) { tool, input }: the tool whose answer { head, body_start } every page carries at the top of its
//                    <head> and the start of its <body> (the consent default and bar, then the site's declared tags; the
//                    Workshop's tool:read-the-site-head), read with the rows and placed by that tool's own withSiteHead
//     files_store    (optional) { endpoint, region, bucket, style, credential }: the site's files store, and the name of its read
//                    key in the unit's credentials (member-video.ts)
//     member_files   (optional, needs files_store) { path, key_prefix, prefixes, link_seconds }: members' files
//     public_files   (optional, needs files_store) { paths, key_prefix, link_seconds, cache_seconds }: the site's public files
//     served_files   (optional, needs files_store) [{ hosts, paths, named, key_prefix, cache_seconds, rest?, only_listed_by? }]:
//                    files this program answers with 200 from the store itself (a web app's shell page, module scripts, engines
//                    and fonts, which a browser loads only from the page's own origin), kept in memory (served-files.ts); with
//                    only_listed_by, only the paths a listing tool's latest answer names (a published clip still consented to)
//   Credentials are files of the unit's credentials folder ($CREDENTIALS_DIRECTORY), sealed there by the computer from the vault.
//   A local run with no credentials folder takes its one credential on standard input, piped from the vault's held-value read.
//
// NON-NEGOTIABLE INVARIANTS
//   1. It holds no database login: every row is read by the engine's run-sql tool, as the site's caller, under a declared use
//      (pages.use) wherever the site is served.
//   2. A members page is drawn only with the member's own pass; its answers are never kept, and it is sent private, no-store.
//   3. When rows cannot be read again, the last good set stays served and the failure is logged; a first read that fails stops
//      the start, so a site never starts with no pages.
//   4. No pass or key is ever logged or written into a page.
//   5. Nothing about any one site is in this file: the settings and the rows are the site.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { chmodSync, existsSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { addressCookiesOf, cookiesFromAddress, withCookies } from './address-cookies.ts';
import type { AddressCookie } from './address-cookies.ts';
import { ask, commandOf, DoorError, runTool, runToolAsCommand } from './door.ts';
import type { CommandDoor, Door, ToolRun } from './door.ts';
import { MemberPasses } from './member-pass.ts';
import type { Member, SignIn } from './member-pass.ts';
import { filesStoreOf, isPublicPath, memberFileAnswer, memberFilesOf, objectKeyOf, presignedGet, publicFileAnswer, publicFilesOf, publicKeyOf, storeKeyOf } from './member-video.ts';
import type { FilesStore, MemberFiles, PublicFiles, StoreKey } from './member-video.ts';
import { closedOnHost, ListedPaths, LISTING_UNREAD, NOT_LISTED, servedFilesOf, servedKeyOf, StoreFiles } from './served-files.ts';
import type { ServedFiles } from './served-files.ts';
import { actionsTableOf, SITE_NAME, SITE_SETTINGS_SQL, SITE_SETTINGS_TABLE, siteHeadOf, siteSettingsOf } from './site-settings.ts';
import type { SiteSettings } from './site-settings.ts';
import { filledInput, hasWordsPlace, matchPage, NOT_FOUND, pagesOf, pagesOn, pathWith, PAGES_SQL, paramsOf, slugsSql } from './pages.ts';
import type { PageRow, Refused } from './pages.ts';
import { actionsOf, actionsSql, bodyOf, cookiesOf, filled, matchAction, outcomeOf, sendableAddress, setCookieOf } from './actions.ts';
import type { ActionReply, ActionRow, Asked } from './actions.ts';
import { pageStyles } from './page-styles.ts';
import { withSiteHead } from '../../site-head-from-its-rows/do-work/site-head.ts';
import type { SiteHeadMarkup } from '../../site-head-from-its-rows/do-work/site-head.ts';
import { drawnTreeOf, fontFaceCss, fontFacesOf, FORM_OUTCOME_PART, lookCss, PageBundles, screensOfTools, THEME_ROW, treeOf, withoutModules, WORDS, wordsTree } from './render.ts';
import type { Screen, Timed } from './render.ts';
import { modulesOf } from './render-layout.ts';
import type { DrawnNode } from './render-layout.ts';
import { kindOf, ScreenFiles } from './screen-files.ts';
import type { Answer } from './screen-files.ts';
import type { FormOutcomeProps } from '../show/FormOutcome.tsx';

export interface Settings {
  listen: string[];
  origin: string;
  hosts: string[];
  lang: string;
  door: { address: string; pass_credential?: string; pins?: string[]; origin?: string; key_credential?: string; peer?: boolean };
  /** settings: the site's name in its pages database's site_settings table (site-settings.ts), whose row says site_head,
   *  served_files and actions instead of this file. */
  pages: { database: string; use?: { purpose: string; surface: string }; refresh_seconds: number; answer_seconds: number; settings?: string };
  sign_in: SignIn & { page: string; signed_out: 'redirect' | 'draw' };
  pass_on: PassOn[];
  addresses?: Record<string, string>;
  address_cookies: AddressCookie[];
  site_head?: { tool: string; input: Record<string, unknown> };
  actions?: string;
  files_store?: FilesStore & { credential: string };
  member_files?: MemberFiles;
  public_files?: PublicFiles;
  served_files: ServedFiles[];
}

const RUN_SQL = 'tool:run-sql-in-my-database';
const LOOK_TABLE = 'site_look';
const PAGES_TABLE = 'pages';
const LOOK_SQL = `SELECT name, value FROM ${LOOK_TABLE} ORDER BY name`;
/**
 * Which of `tables` ($2) changed since the last ask, in one statement: row_changes' newest position, the tables of its rows
 * after the last position seen ($1) or written by a transaction that was still open then (txid at or after that ask's snapshot
 * xmin, $3, so a change that took its position before the ask and committed after it is not missed), the tables of $2 that
 * tell their changes (a tell_row_change trigger), and this snapshot's xmin for the next ask.
 */
export const CHANGES_SQL = `SELECT (SELECT max(position) FROM row_changes)::text AS newest,
  (SELECT coalesce(array_agg(DISTINCT table_name), '{}') FROM row_changes WHERE position > $1::bigint OR txid >= $3::xid8) AS changed,
  (SELECT coalesce(array_agg(DISTINCT c.relname::text), '{}') FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal AND t.tgname LIKE 'tell_row_change%' AND c.relname = ANY ($2::text[])) AS told,
  pg_snapshot_xmin(pg_current_snapshot())::text AS xmin`;
/** The site's look row with its own words for a form post that did not go through, when no action row's `failed` says them. */
export const FORM_FAILED_ROW = `${WORDS}form-failed`;
export const FORM_FAILED_TITLE = 'That did not go through';
export const FORM_FAILED_WORDS = 'Nothing was sent. Check what you typed and try again in a minute.';
// Typed values are put back only from fields a page may show again: never a password, card, secret or one-time code.
const NOT_PUT_BACK = /pass|card|cvc|cvv|secret|token|otp|one[-_.]?time/i;
const MOST_PUT_BACK_LENGTH = 4000;

/** A browser's form post that did not go through: where it posted, the row's words if any, the page it came from, what was typed. */
export interface FailedPost {
  action: string;
  words: string | null;
  referer: string | undefined;
  cookie: string | undefined;
  values: Record<string, string>;
}

/** A request's headers by lower-case name, each one value (a repeated header joined by ", "), for a row's header source. */
export function headersOf(headers: http.IncomingHttpHeaders | undefined): Record<string, string> {
  const one: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) if (value !== undefined) one[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  return one;
}

/** What a visitor typed in a form, by field name, that the page may put back: text values only, never a secret's. */
export function typedValuesOf(body: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(body).filter((pair): pair is [string, string] => typeof pair[1] === 'string' && pair[1].length <= MOST_PUT_BACK_LENGTH && !NOT_PUT_BACK.test(pair[0])));
}

/** The typed values of a form body passed on to another program: a URL-encoded form's, else none. */
export function formValuesOf(contentType: string | undefined, bytes: Buffer): Record<string, string> {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  return type === 'application/x-www-form-urlencoded' ? typedValuesOf(Object.fromEntries(new URLSearchParams(bytes.toString('utf8')))) : {};
}
const MOST_KEPT_ANSWERS = 1000;
/** The most bytes an action's posted body may hold. */
export const MOST_ACTION_BYTES = 65536;
/** The longest a stop waits for the calls already taken, inside a unit's 30 s stop time. */
const STOP_MS = 25_000;
export const LOCAL_LISTEN = '127.0.0.1:18440';
// Stands for the site's own caller when reads go through a command: no pass is held then.
const COMMAND_PASS = 'the computer\'s own command';
// Stands for the site's own caller on the engine's vault socket: the engine knows it by its OS user, so no pass is held.
const PEER_PASS = 'the site\'s own OS user';

/** The call with the pages' declared use given to it when its input names a database and no use; any other call as it is. */
export function withPagesUse(use: Settings['pages']['use'], call: ToolRun): ToolRun {
  const input = call.input as Record<string, unknown> | null;
  if (!use || !input || typeof input !== 'object' || Array.isArray(input) || typeof input.database !== 'string' || input.use !== undefined) return call;
  return { ...call, input: { ...input, use } };
}
const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Checks a settings file's value; a wrong one throws with what it should be. */
export function settingsOf(value: unknown): Settings {
  const given = value as Partial<Settings> | null;
  const listen = (given as { listen?: unknown } | null)?.listen ?? LOCAL_LISTEN;
  const s = given ? { ...given, listen: typeof listen === 'string' ? [listen] : listen, hosts: given.hosts ?? [], pass_on: given.pass_on ?? [], sign_in: given.sign_in ? { ...given.sign_in, signed_out: given.sign_in.signed_out ?? 'redirect' } : given.sign_in } : null;
  if (!s || !Array.isArray(s.listen) || s.listen.length === 0 || s.listen.some(at => typeof at !== 'string' || !/^(unix:\/.+|[0-9.]+:\d+|\[[0-9a-f:]+\]:\d+)$/i.test(at))) {
    throw new Error('listen is "unix:/path/to.sock" or "host:port", or a list of them.');
  }
  if (typeof s.origin !== 'string' || !/^https?:\/\/[^/]+$/.test(s.origin)) throw new Error('origin is the site\'s address, such as https://example.com.');
  if (!Array.isArray(s.hosts) || s.hosts.some(host => typeof host !== 'string' || !HOST_NAME.test(host))) throw new Error('hosts lists lower-case host names, such as ["app.example.com"].');
  if (typeof s.lang !== 'string' || !/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(s.lang)) throw new Error('lang is a language tag, such as "en".');
  const byCommand = s.door && typeof s.door.address === 'string' && commandOf(s.door.address) !== null;
  const byPeer = s.door && s.door.peer !== undefined;
  if (byPeer && (s.door!.peer !== true || typeof s.door!.address !== 'string' || !s.door!.address.startsWith('unix:/') || s.door!.pass_credential !== undefined
    || s.door!.pins !== undefined || s.door!.origin !== undefined || s.door!.key_credential !== undefined)) {
    throw new Error('door { address: "unix:<the engine\'s vault socket>", peer: true } names nothing else: the engine knows the site by its OS user.');
  }
  if (!s.door || typeof s.door.address !== 'string' || (!byCommand && !byPeer && typeof s.door.pass_credential !== 'string')
    || (s.door.pins !== undefined && (!Array.isArray(s.door.pins) || s.door.pins.some(pin => typeof pin !== 'string')))
    || (!byCommand && (s.door.origin !== undefined || s.door.key_credential !== undefined))
    || (s.door.origin !== undefined && (typeof s.door.origin !== 'string' || !/^https?:\/\/[^/?#\s]+$/.test(s.door.origin)))
    || (s.door.key_credential !== undefined && typeof s.door.key_credential !== 'string')) {
    throw new Error('door is { address, pass_credential } (or { address: "cli:<command>", pins, origin?, key_credential? } to run each read as the computer\'s own command).');
  }
  const p = s.pages;
  if (!p || typeof p.database !== 'string' || (p.use !== undefined && (!p.use || typeof p.use.purpose !== 'string' || typeof p.use.surface !== 'string'))
    || !Number.isInteger(p.refresh_seconds) || p.refresh_seconds < 1 || !Number.isInteger(p.answer_seconds) || p.answer_seconds < 0) {
    throw new Error('pages is { database, use?: { purpose, surface }, refresh_seconds (1 or more), answer_seconds (0 or more) }.');
  }
  if (p.settings !== undefined) {
    if (typeof p.settings !== 'string' || !SITE_NAME.test(p.settings)) throw new Error('pages.settings is the site\'s name in its site_settings row, such as example.com.');
    const both = (['site_head', 'served_files', 'actions'] as const).filter(key => (given as Record<string, unknown>)[key] !== undefined);
    if (both.length) throw new Error(`pages.settings names the site's settings row, which says ${both.join(', ')}; this file does not say them too.`);
  }
  const i = s.sign_in;
  if (!i || ['address', 'page', 'issuer', 'audience', 'team_claim', 'members_team'].some(key => typeof (i as unknown as Record<string, unknown>)[key] !== 'string') || !i.page.startsWith('/')) {
    throw new Error('sign_in is { address, page (a site path), issuer, audience, team_claim, members_team }.');
  }
  if (i.signed_out !== 'redirect' && i.signed_out !== 'draw') throw new Error('sign_in.signed_out is "redirect" or "draw".');
  const sitePath = (path: unknown) => typeof path === 'string' && /^\/[A-Za-z0-9._~\/:@-]*$/.test(path);
  const addresses = (given as { addresses?: unknown }).addresses ?? {};
  if (!addresses || typeof addresses !== 'object' || Array.isArray(addresses) || Object.values(addresses).some(at => typeof at !== 'string' || at.startsWith('named:'))) {
    throw new Error('addresses is { <name>: address }, each address a URL or unix:/path, never another name.');
  }
  if (!Array.isArray(s.pass_on) || s.pass_on.some(on => !on || typeof on.name !== 'string' || typeof on.address !== 'string'
    || !(Array.isArray(on.paths ?? []) && (on.paths ?? []).every(sitePath)) || !(Array.isArray(on.exact ?? []) && (on.exact ?? []).every(sitePath))
    || !(Array.isArray(on.hosts ?? []) && (on.hosts ?? []).every(host => typeof host === 'string' && HOST_NAME.test(host)))
    || (on.site_head !== undefined && typeof on.site_head !== 'boolean') || (on.first !== undefined && typeof on.first !== 'boolean')
    || (on.stream !== undefined && (typeof on.stream !== 'boolean' || (on.stream && on.site_head === true)))
    || (on.form_as_json !== undefined && (typeof on.form_as_json !== 'boolean' || (on.form_as_json && on.stream === true))))) {
    throw new Error('pass_on lists { name, address, paths (a path and what is under it), exact (that path only, before the site\'s own rows), hosts (only these hosts; every host when left out), first (true: its paths too come before the site\'s own rows), site_head (true: its pages carry the site head too), stream (true: piped as it comes, every header unchanged, never with site_head), form_as_json (true: a browser\'s form post reaches it as JSON, never with stream) }.');
  }
  const named = addresses as Record<string, string>;
  for (const on of s.pass_on) {
    const name = /^named:(.+)$/.exec(on.address)?.[1];
    if (name === undefined) continue;
    if (!Object.hasOwn(named, name)) throw new Error(`pass_on ${on.name} names the address ${name}, which addresses does not hold.`);
    on.address = named[name];
  }
  siteHeadOf(s.site_head);
  s.address_cookies = addressCookiesOf((given as { address_cookies?: unknown }).address_cookies);
  actionsTableOf(s.actions);
  if (s.files_store !== undefined) {
    filesStoreOf(s.files_store);
    if (typeof s.files_store.credential !== 'string') throw new Error('files_store.credential names the store\'s read key in the unit\'s credentials.');
  }
  s.served_files = servedFilesOf((given as { served_files?: unknown }).served_files);
  if ((s.member_files !== undefined || s.public_files !== undefined || s.served_files.length > 0) && s.files_store === undefined) throw new Error('member_files, public_files and served_files need files_store.');
  return {
    ...s,
    ...(s.member_files !== undefined ? { member_files: memberFilesOf(s.member_files) } : {}),
    ...(s.public_files !== undefined ? { public_files: publicFilesOf(s.public_files) } : {}),
  } as Settings;
}

/** One credential of the unit, by name, from its credentials folder. */
export function credential(name: string, folder = process.env.CREDENTIALS_DIRECTORY): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`The credential ${name} is not a credential name.`);
  if (folder) return readFileSync(join(folder, name), 'utf8').trim();
  // A local run: the one credential arrives on standard input, piped from the vault's held-value read; it is read once.
  if (process.stdin.isTTY) throw new Error(`The credential ${name} is not in this unit's credentials, and nothing is piped in.`);
  if (piped.name !== null && piped.name !== name) throw new Error(`Standard input holds the credential ${piped.name}; a local run takes one credential.`);
  piped.name = name;
  // Opened by its path, a blocking read of its own: fd 0 is the parent's, and a pipe whose writer has not written yet answers
  // EAGAIN when that fd was left non-blocking.
  piped.value ??= readFileSync('/dev/stdin', 'utf8').trim();
  return piped.value;
}
const piped: { name: string | null; value: string | null } = { name: null, value: null };

export interface SiteParts {
  settings: Settings;
  /** The Workshop's tools folder the screens and parts are read from. */
  tools: string;
  /** Runs one tool on the door as the caller whose pass is given (door.ts runTool). */
  run: (pass: string, call: ToolRun) => Promise<unknown>;
  sitePass: string;
  passes: { memberOfCookie(cookie: string | undefined): Promise<Member | null> };
  storeKey: StoreKey | null;
  /** The served files' reader and its kept copies (served-files.ts), or null when the site serves none. */
  storeFiles?: StoreFiles | null;
  bundles: PageBundles;
  /** Reads a font file a look row names (a public file path or an https address), keeps it by identity, answers its address. */
  keepFont: (src: string) => Promise<string>;
  /** The CSS variables of the site's Screen Look theme (page-styles.ts palette). */
  palette: (theme: string | null) => string;
  files: ScreenFiles;
  screens: Map<string, Screen>;
  log?: (line: string) => void;
}

interface Kept { at: number; answer: unknown }

const xml = (text: string): string => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

export class Site {
  #parts: SiteParts;
  #pages: PageRow[] = [];
  #refused: Refused[] = [];
  #actions: ActionRow[] = [];
  // Each template page's collection: its slugs, read with the rows; the sitemap lists them and an address outside them is 404.
  #slugs = new Map<string, Set<string>>();
  #refusedActions: Refused[] = [];
  #look = '';
  // The site's own words for a form post that did not go through (its look row words.form-failed), or null for the tool's own.
  #formFailed: string | null = null;
  #head: SiteHeadMarkup | null = null;
  #readAt = 0;
  #reading: Promise<void> | null = null;
  // The rows of each kind as last read, kept until a change names their table (read()); the row_changes place last asked from.
  #kept: { pages?: Record<string, unknown>[]; look?: Record<string, unknown>[]; actions?: { table: string; rows: Record<string, unknown>[] }; slugs: Map<string, Set<string>> } = { slugs: new Map() };
  #since: { position: string; xmin: string } | null = null;
  #changesUnread = false;
  #answers = new Map<string, Kept>();
  #log: (line: string) => void;
  // The paths each served_files rule's only_listed_by tool names, run with the site's own key.
  #listed: ListedPaths;

  // What the site runs as itself: the settings file's, or, when it names a settings row, that row's as last read.
  #own: SiteSettings;

  constructor(parts: SiteParts) {
    this.#parts = parts;
    // A site whose settings name a settings row runs nothing of its own until that row is read (read()).
    const { site_head, served_files, actions } = parts.settings.pages.settings === undefined ? parts.settings : { served_files: [] } as Partial<Settings>;
    this.#own = { use: parts.settings.pages.use, ...(site_head ? { site_head } : {}), served_files: served_files ?? [], ...(actions ? { actions } : {}) };
    this.#log = parts.log ?? (line => console.error(line));
    this.#listed = new ListedPaths(call => parts.run(parts.sitePass, call));
  }

  #sql(sql: string, params: unknown[] = [], other?: string): Promise<Record<string, unknown>[]> {
    const { database: own, use } = this.#parts.settings.pages;
    const database = other ?? own;
    return this.#parts.run(this.#parts.sitePass, { tool: RUN_SQL, input: { database, sql, params, ...(use ? { use } : {}) } })
      .then(answer => {
        const rows = (answer as { rows?: unknown } | null)?.rows;
        if (!Array.isArray(rows)) throw new DoorError(`${RUN_SQL} answered no rows.`);
        return rows as Record<string, unknown>[];
      });
  }

  /**
   * Reads again each kind of row a change named since the last read (all of them the first time), and every kind whose table
   * does not tell its changes; throws when a kind cannot be read or a row is broken, and then keeps the last good set and asks
   * again from the same place next time.
   */
  async read(): Promise<void> {
    const { settings: site, use } = this.#parts.settings.pages;
    const collectionsKept = [...this.#kept.slugs.keys()];
    const tables = [...new Set([...(site === undefined ? [] : [SITE_SETTINGS_TABLE]), PAGES_TABLE, LOOK_TABLE, ...(this.#own.actions ? [this.#own.actions] : []), ...collectionsKept])];
    const changes = await this.#changesSince(tables);
    const stale = (table: string) => changes === null || !changes.told.has(table) || changes.changed.has(table);
    const own = site === undefined ? this.#own : stale(SITE_SETTINGS_TABLE) || this.#readAt === 0 ? siteSettingsOf(await this.#sql(SITE_SETTINGS_SQL, [site]), site, use) : this.#own;
    const table = own.actions;
    const keptActions = this.#kept.actions;
    const [pages, look, head, actionRows] = await Promise.all([
      this.#kept.pages && !stale(PAGES_TABLE) ? this.#kept.pages : this.#sql(PAGES_SQL),
      this.#kept.look && !stale(LOOK_TABLE) ? this.#kept.look : this.#sql(LOOK_SQL),
      this.#siteHead(own.site_head),
      !table ? [] : keptActions && keptActions.table === table && !stale(table) ? keptActions.rows : this.#sql(actionsSql(table)),
    ]);
    const { actions, refused: refusedActions } = actionsOf(actionRows);
    for (const { path, why } of refusedActions) if (!this.#refusedActions.some(r => r.path === path && r.why === why)) this.#log(`action row set aside: ${why}`);
    const { pages: good, refused } = pagesOf(pages);
    for (const { path, why } of refused) if (!this.#refused.some(r => r.path === path && r.why === why)) this.#log(`page row set aside: ${why}`);
    const collections = [...new Set(good.filter(page => page.collection && paramsOf(page.path).length === 1).map(page => page.collection!))];
    const slugs = new Map(await Promise.all(collections.map(async collection => [collection, this.#kept.slugs.has(collection) && !stale(collection) ? this.#kept.slugs.get(collection)!
      : new Set((await this.#sql(slugsSql(collection))).map(row => row.slug).filter((slug): slug is string => typeof slug === 'string' && slug !== ''))] as const)));
    if (pages !== this.#kept.pages || look !== this.#kept.look || this.#readAt === 0) {
      const theme = look.find(row => row.name === THEME_ROW)?.value;
      const faces = await Promise.all(fontFacesOf(look).map(async face => ({ ...face, address: await this.#parts.keepFont(face.src) })));
      this.#look = `${fontFaceCss(faces)}${this.#parts.palette(typeof theme === 'string' ? theme : null)}${lookCss(look)}`;
      const formFailed = look.find(row => row.name === FORM_FAILED_ROW)?.value;
      this.#formFailed = typeof formFailed === 'string' && formFailed.trim() ? formFailed.trim() : null;
    }
    this.#pages = good;
    this.#slugs = slugs;
    this.#actions = actions;
    this.#refusedActions = refusedActions;
    this.#refused = refused;
    this.#kept = { pages, look, ...(table ? { actions: { table, rows: actionRows } } : {}), slugs };
    this.#head = head;
    this.#own = own;
    if (changes) this.#since = { position: changes.newest, xmin: changes.xmin };
    this.#readAt = Date.now();
  }

  // Which of `tables` changed since the last read, and which tell their changes; null when everything is to be read (the first
  // read, or a row_changes this login cannot read: then every kind is read each time, as before, and that is said once).
  async #changesSince(tables: string[]): Promise<{ newest: string; xmin: string; changed: Set<string>; told: Set<string> } | null> {
    let rows: Record<string, unknown>[];
    try {
      rows = await this.#sql(CHANGES_SQL, [this.#since?.position ?? '-1', tables, this.#since?.xmin ?? '0']);
    } catch (error) {
      if (!this.#changesUnread) this.#log(`The row changes could not be read, so every kind of row is read again each time: ${(error as Error).message}`);
      this.#changesUnread = true;
      return null;
    }
    this.#changesUnread = false;
    const [row] = rows;
    const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : typeof value === 'string' ? value.replace(/^\{|\}$/g, '').split(',').filter(Boolean) : []);
    const changes = { newest: typeof row?.newest === 'string' ? row.newest : String(row?.newest ?? '0'), xmin: String(row?.xmin ?? '0'), changed: new Set(list(row?.changed)), told: new Set(list(row?.told)) };
    // The first ask only sets the place: every kind is read.
    return this.#since === null ? { ...changes, told: new Set() } : changes;
  }

  /** What the site runs as itself, as last read: its site head, served files and action table. */
  get own(): SiteSettings {
    return this.#own;
  }

  // The site head's markup, read by its tool with the rows; a site with no site_head carries none.
  async #siteHead(call: SiteSettings['site_head']): Promise<SiteHeadMarkup | null> {
    if (!call) return null;
    const answer = await this.#parts.run(this.#parts.sitePass, call) as { head?: unknown; body_start?: unknown } | null;
    if (typeof answer?.head !== 'string' || typeof answer.body_start !== 'string') throw new DoorError(`${call.tool} answered no { head, body_start }.`);
    return { head: answer.head, bodyStart: answer.body_start };
  }

  // Rows older than refresh_seconds are read again behind the request; the last good set answers meanwhile.
  #fresh(): void {
    if (this.#reading || Date.now() - this.#readAt < this.#parts.settings.pages.refresh_seconds * 1000) return;
    this.#reading = this.read()
      .catch(error => this.#log(`The page rows were not read again; the last good set stays: ${(error as Error).message}`))
      .finally(() => { this.#reading = null; });
  }

  get pages(): PageRow[] {
    return this.#pages;
  }

  get refused(): Refused[] {
    return this.#refused;
  }

  async #publicRun(call: ToolRun): Promise<unknown> {
    const seconds = this.#parts.settings.pages.answer_seconds;
    const key = JSON.stringify(call);
    const kept = this.#answers.get(key);
    if (kept && Date.now() - kept.at < seconds * 1000) return kept.answer;
    const answer = await this.#parts.run(this.#parts.sitePass, call);
    if (seconds > 0) {
      this.#answers.delete(key);
      this.#answers.set(key, { at: Date.now(), answer });
      if (this.#answers.size > MOST_KEPT_ANSWERS) this.#answers.delete(this.#answers.keys().next().value!);
    }
    return answer;
  }

  /** The host a request is for: one the site answers, else origin's. */
  hostOf(forwarded: string | undefined, host: string | undefined): string {
    const { origin, hosts } = this.#parts.settings;
    const asked = (forwarded ?? host ?? '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
    const own = new URL(origin).hostname;
    return asked === own || hosts.includes(asked) ? asked : own;
  }

  #originOf(host: string): string {
    return `${new URL(this.#parts.settings.origin).protocol}//${host}`;
  }

  async #document(title: string, host: string, pathname: string, given: DrawnNode, goTo?: string): Promise<string> {
    // A part or export the rows name that this program's tools lack (rows ahead of the running commit) draws nothing, and the
    // rest of the page is drawn; the log names each one (rows-need-parts.ts lists them before a move).
    const missing = await this.#parts.bundles.missingOf(modulesOf(given));
    for (const { why } of missing) this.#log(`${pathname}: ${why}, so that part of the page is left out.`);
    const tree = missing.length ? withoutModules(given, new Set(missing.map(part => part.key))) : given;
    const bundle = await this.#parts.bundles.bundleFor(modulesOf(tree));
    const html = bundle.html({ lang: this.#parts.settings.lang, title, canonical: `${this.#originOf(host)}${pathname}`, look: this.#look, ...(goTo ? { goTo } : {}) }, tree);
    return this.#head ? withSiteHead(html, this.#head) : html;
  }

  async #drawn(page: PageRow, params: Record<string, string>, host: string, pathname: string, run: (call: ToolRun) => Promise<unknown>, status: number, cache: string, query = new URLSearchParams(), outcome?: FormOutcomeProps, words?: DrawnNode): Promise<Answer> {
    if (page.layout && 'go_to' in page.layout) {
      const goTo = pathWith(page.layout.go_to, params);
      const body = await this.#document(page.title ?? goTo, host, pathname, wordsTree(page.title ?? '', goTo), goTo);
      return { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': cache }, body };
    }
    const { drawn, timed, answerOf } = await drawnTreeOf(treeOf(page, params, query), this.#parts.screens, run, words, line => this.#log(`${pathname}: ${line}`));
    const answered = page.tool ? answerOf({ tool: page.tool, input: filledInput(page.input, params, query) })?.title : undefined;
    const title = page.title ?? (typeof answered === 'string' && answered.trim() ? answered : null);
    if (title === null) throw new Error(`page ${page.path}: its row has no title and ${page.tool} answered none.`);
    const body = await this.#document(title, host, pathname, outcome ? { module: FORM_OUTCOME_PART, props: { ...outcome }, children: [drawn] } : drawn);
    return { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': cache, 'server-timing': serverTiming(timed) }, body };
  }

  /**
   * A page of words: the shared card (render.ts wordsTree) at the { "words": true } place of the host's public not-found row,
   * so it wears the site's frame, or alone when the site has no such row or its frame cannot be drawn now.
   */
  async #words(status: number, heading: string, words: string, host: string, pathname: string, back?: { href: string; label: string }): Promise<Answer> {
    const card = wordsTree(heading, words, back);
    const frame = pagesOn(this.#pages, host).find(row => row.path === NOT_FOUND && row.access === 'public' && hasWordsPlace(row.layout));
    if (frame) {
      try {
        const framed = await this.#drawn({ ...frame, title: heading }, {}, host, pathname, call => this.#publicRun(call), status, 'no-store', undefined, undefined, card);
        return { ...framed, headers: { ...framed.headers, 'cache-control': 'no-store' } };
      } catch (error) {
        this.#log(`${pathname}: the site's words page could not be drawn, so its words are drawn alone: ${(error as Error).message}`);
      }
    }
    const body = await this.#document(heading, host, pathname, card);
    return { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body };
  }

  /**
   * What a browser's form post that did not go through gets, whichever program it went to, never raw JSON: the page it was
   * posted from (the Referer's path, drawn as this site's page for this host) drawn again with the failure's status, the shared
   * FormAlert at the form that posted to `post.action` and what the visitor typed put back (show/FormOutcome.tsx). When the
   * Referer is no page of this site, the site's page of the same words with a way back. The words are `post.words` (an action
   * row's own `failed`) when given, else the site's look row words.form-failed, else the tool's own FORM_FAILED_WORDS.
   */
  async failedForm(status: number, host: string, post: FailedPost): Promise<Answer> {
    const message = post.words ?? this.#formFailed ?? FORM_FAILED_WORDS;
    const back = backTo(post.referer);
    const outcome: FormOutcomeProps = { action: post.action, title: FORM_FAILED_TITLE, message, values: post.values };
    const again = await this.answer('GET', back, post.cookie, host, undefined, outcome).catch(() => null);
    if (again && again.status === 200 && again.headers['content-type']?.startsWith('text/html')) return { ...again, status, headers: { ...again.headers, 'cache-control': 'no-store' } };
    return this.#words(status, FORM_FAILED_TITLE, message, host, post.action, { href: back, label: 'Back' });
  }

  async #notFound(pages: PageRow[], host: string, pathname: string): Promise<Answer> {
    const page = pages.find(row => row.path === NOT_FOUND && row.access === 'public');
    if (page && !hasWordsPlace(page.layout)) return this.#drawn(page, {}, host, pathname, call => this.#publicRun(call), 404, 'no-store');
    return this.#words(404, 'Not found', 'There is no page at this address.', host, pathname);
  }

  async #sitemap(pages: PageRow[], host: string): Promise<Answer> {
    const origin = this.#originOf(host);
    const entries: { loc: string; lastmod: string | null }[] = [];
    for (const page of pages.filter(row => row.access === 'public' && row.path !== NOT_FOUND)) {
      const names = paramsOf(page.path);
      if (!names.length) { entries.push({ loc: `${origin}${page.path}`, lastmod: page.updated_at }); continue; }
      if (names.length !== 1 || !page.collection) continue;
      for (const slug of this.#slugs.get(page.collection) ?? []) entries.push({ loc: `${origin}${pathWith(page.path, { [names[0]]: slug })}`, lastmod: page.updated_at });
    }
    const urls = entries.map(({ loc, lastmod }) => `<url><loc>${xml(loc)}</loc>${lastmod ? `<lastmod>${xml(lastmod.slice(0, 10))}</lastmod>` : ''}</url>`).join('\n');
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
    return { status: 200, headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=300' }, body };
  }

  /** The site head's markup as last read, or null when the site has none. */
  get siteHead(): SiteHeadMarkup | null {
    return this.#head;
  }

  /** True when a served_files rule closes this host to every path it does not name (rest "not_found"). */
  closed(host: string, pathname: string): boolean {
    return closedOnHost(this.#own.served_files, host, pathname);
  }

  /** True when an action row answers this method at this host and path. Asking keeps the rows fresh, as every request does. */
  acts(method: string, host: string, pathname: string): boolean {
    this.#fresh();
    return matchAction(this.#actions, method, host, pathname) !== null;
  }

  /** The path pattern of the page row that answers this host and path (a template page only for a slug it holds), or null. */
  pageFor(host: string, pathname: string): string | null {
    const matched = matchPage(pagesOn(this.#pages, host), pathname);
    if (!matched || matched.page.path === NOT_FOUND) return null;
    const names = paramsOf(matched.page.path);
    if (matched.page.collection && names.length === 1 && !this.#slugs.get(matched.page.collection)?.has(matched.params[names[0]])) return null;
    return matched.page.path;
  }

  /**
   * The answer for one action: the action row for the method, host and path, its tool run with the input made from the
   * request (as the member when one is signed in, else as the site), and the row's answer. A form post is sent on with 303;
   * a JSON post gets JSON ({ "redirect": address } for a redirect). A GET (no body) gets the JSON keys, or is sent on with 303.
   */
  async act(address: string, cookie: string | undefined, host: string, request: { method?: string; contentType?: string; origin?: string; hostHeader?: string; referer?: string; network?: string | null; headers?: http.IncomingHttpHeaders; bytes: Buffer }): Promise<Answer> {
    const url = new URL(address, 'http://site.invalid');
    const pathname = url.pathname;
    const method = request.method ?? 'POST';
    const json = (status: number, value: unknown): Answer => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(value) });
    this.#fresh();
    const matched = matchAction(this.#actions, method, host, pathname);
    if (!matched) return json(404, { error: 'Nothing is done at this address.' });
    // A browser names the page a post came from (Origin): it must be one of the site's hosts, or the very address this
    // request was sent to (the page and the post on one origin, as a local run is).
    if (request.origin !== undefined && request.origin !== 'null') {
      let from: URL | null = null;
      try { from = new URL(request.origin); } catch { from = null; }
      const own = from !== null && (this.hostOf(from.hostname, undefined) === from.hostname || (request.hostHeader !== undefined && from.host === request.hostHeader));
      if (!own) return json(403, { error: 'This is done only from this site\'s own pages.' });
    }
    if (request.bytes.length > MOST_ACTION_BYTES) return json(413, { error: 'Too large.' });
    const { page: action, params } = matched;
    let posted: { body: Record<string, unknown>; form: boolean };
    // A GET carries no body; one that sends the visitor on is a link followed in the browser, so its failure is a page.
    if (action.method === 'GET') posted = { body: {}, form: !('json' in action.answer) };
    else try { posted = bodyOf(request.contentType, request.bytes); } catch (error) { return json(400, { error: (error as Error).message }); }
    // A browser's form gets its own page again with the row's words at the form; a page script gets JSON.
    const failed = async (status: number, said: string | null): Promise<Answer> => (posted.form
      ? this.failedForm(status, host, { action: pathname, words: said ? `${action.failed} ${said}` : action.failed, referer: request.referer, cookie, values: typedValuesOf(posted.body) })
      : json(status, { error: action.failed, ...(said ? { why: said } : {}) }));
    const member = await this.#parts.passes.memberOfCookie(cookie);
    if (action.access === 'members' && !member) return posted.form ? failed(403, 'Sign in as a member first.') : json(403, { error: 'Sign in as a member first.' });
    const pass = member ? member.pass : this.#parts.sitePass;
    // The row's own tool's words for why, when the row says to tell them; never a nested tool's, never a transport failure's.
    const why = (error: unknown): string | null => (action.says_why && error instanceof DoorError && error.refusal?.tool === action.tool ? error.refusal.words : null);
    try {
      // A tool source that names one tool with one input is one run in this request, however many keys of its answer are read.
      const ran = new Map<string, Promise<unknown>>();
      const asked: Asked = {
        body: posted.body, params, query: url.searchParams, cookies: cookiesOf(cookie), claims: member?.claims ?? null, origin: this.#originOf(host),
        referer: request.referer ?? null, network: request.network ?? null,
        raw: request.bytes.length ? request.bytes.toString('utf8') : undefined, headers: headersOf(request.headers),
        rows: (sql, values, database) => this.#sql(sql, values, database), answer: null, input: null,
        tool: (tool, input) => {
          const key = JSON.stringify([tool, input]);
          if (!ran.has(key)) ran.set(key, this.#parts.run(pass, { tool, input }));
          return ran.get(key)!;
        },
      };
      const input = await filled(action.input, asked);
      let answer: Record<string, unknown> | null;
      try {
        answer = await this.#parts.run(pass, { tool: action.tool, input }) as Record<string, unknown> | null;
      } catch (error) {
        // The row's own tool failed after its input's tools had done their part: the undo puts that back.
        if (action.undo) {
          const undo = action.undo;
          await this.#parts.run(pass, { tool: undo.tool, input: (await filled(undo.input, { ...asked, input })) ?? {} })
            .catch(undone => this.#log(`${method} ${pathname}: ${undo.tool} did not undo: ${(undone as Error).message}`));
        }
        throw error;
      }
      const answered: Asked = { ...asked, answer, input };
      // An answer the row names in `outcomes` ends the request as that named failure: its status and words, nothing run after.
      const named = outcomeOf(action.outcomes, answer);
      if (named) {
        return posted.form
          ? this.failedForm(named.redraw, host, { action: pathname, words: named.words, referer: request.referer, cookie, values: typedValuesOf(posted.body) })
          : json(named.redraw, { error: named.words, outcome: named.value });
      }
      // The row's next steps, in order, each when its `when` gives true: one that fails runs its failed step and fails the request.
      for (const step of action.next) {
        if ((await filled(step.when, answered)) !== true) continue;
        try {
          await this.#parts.run(pass, { tool: step.tool, input: (await filled(step.input, answered)) ?? {} });
        } catch (error) {
          if (step.failed) {
            const after = step.failed;
            await this.#parts.run(pass, { tool: after.tool, input: (await filled(after.input, answered)) ?? {} })
              .catch(also => this.#log(`${method} ${pathname}: ${after.tool} did not finish after ${step.tool} failed: ${(also as Error).message}`));
          }
          throw error;
        }
      }
      // What the row keeps once its own tool answered (a journey step for a checkout that started): its failure is only logged.
      if (action.then) {
        const then = action.then;
        await this.#parts.run(pass, { tool: then.tool, input: (await filled(then.input, answered)) ?? {} })
          .catch(error => this.#log(`${method} ${pathname}: ${then.tool} did not finish after ${action.tool}: ${(error as Error).message}`));
      }
      const setCookie = action.answer.cookie ? setCookieOf(action.answer.cookie, await filled(action.answer.cookie.value, answered), asked.cookies) : null;
      const withCookie = (sent: Answer): Answer => (setCookie ? { ...sent, headers: { ...sent.headers, 'set-cookie': setCookie } } : sent);
      if ('json' in action.answer) return withCookie(json(200, Object.fromEntries(action.answer.json.map(key => [key, answer?.[key] ?? null]))));
      if ('reply' in action.answer) return withCookie(await replyOf(action.answer.reply, answer, answered, action.failed));
      const to = sendableAddress('redirect_from' in action.answer ? answer?.[action.answer.redirect_from] : await filled(action.answer.redirect_to, answered));
      if (!to) throw new Error(`${action.tool} answered no address to send the visitor to.`);
      return withCookie(posted.form ? { status: 303, headers: { location: to, 'cache-control': 'no-store' }, body: '' } : json(200, { redirect: to }));
    } catch (error) {
      this.#log(`${method} ${pathname}: ${(error as Error).message}`);
      const said = why(error);
      // A tool's own refusal keeps the status it named (400 to 499, door.ts refusalOf); a busy or timed-out door (503, 504) is
      // told as such, so a page tries again; a refused pass is 403; a refusal the row tells without a status of its own is 422;
      // anything else 502.
      const own = error instanceof DoorError && error.refusal !== null && error.status >= 400 && error.status <= 499 ? error.status : null;
      const passed = error instanceof DoorError && [403, 503, 504].includes(error.status) ? error.status : 502;
      return failed(own ?? (said ? 422 : passed), said);
    }
  }

  /** The answer for one request: its method, its address (path and query), its cookie and its host (hostOf). */
  async answer(method: string, address: string, cookie: string | undefined, host = this.hostOf(undefined, undefined), range?: string, outcome?: FormOutcomeProps): Promise<Answer> {
    const url = new URL(address, 'http://site.invalid');
    const pathname = url.pathname;
    if (method !== 'GET' && method !== 'HEAD') return { status: 405, headers: { allow: 'GET, HEAD, POST', 'content-type': 'text/plain; charset=utf-8' }, body: 'This address answers GET and HEAD, and POST where the site does something.\n' };
    const file = this.#parts.files.answer(pathname);
    if (file) return file;
    this.#fresh();
    const { files_store: store, member_files: memberFiles, public_files: publicFiles } = this.#parts.settings;
    const served = this.#parts.storeFiles ? servedKeyOf(this.#own.served_files, host, pathname) : null;
    if (served) {
      const listing = served.rule.only_listed_by;
      if (listing) {
        try {
          if (!await this.#listed.names(listing, pathname)) return NOT_LISTED;
        } catch (error) {
          this.#log(`${pathname}: ${listing.tool} did not answer, so its listed files are not shown: ${(error as Error).message}`);
          return LISTING_UNREAD;
        }
      }
      return this.#parts.storeFiles!.answer(served.rule, served.key, range);
    }
    if (store && memberFiles && pathname.startsWith(memberFiles.path)) {
      const key = objectKeyOf(memberFiles, pathname);
      if (!key || !this.#parts.storeKey) return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' }, body: 'No such file.\n' };
      return memberFileAnswer(store, memberFiles, this.#parts.storeKey, key, await this.#parts.passes.memberOfCookie(cookie));
    }
    if (store && publicFiles && isPublicPath(publicFiles, pathname)) {
      const key = publicKeyOf(publicFiles, pathname);
      if (!key || !this.#parts.storeKey) return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: 'No such file.\n' };
      return publicFileAnswer(store, publicFiles, this.#parts.storeKey, key);
    }
    const pages = pagesOn(this.#pages, host);
    try {
      if (pathname === '/sitemap.xml') return await this.#sitemap(pages, host);
      const matched = matchPage(pages, pathname);
      // An old address of a page, "<path>.html" or "<path>/index.html" (a bookmark, a link from the old site), is 301 to the page
      // at "<path>", its query kept, unless a page row has that exact address.
      const clean = pathname.endsWith('/index.html') ? pathname.slice(0, -'/index.html'.length) || '/' : pathname.endsWith('.html') ? pathname.slice(0, -'.html'.length) : null;
      if (clean && clean !== pathname && !(matched && paramsOf(matched.page.path).length === 0)) {
        const page = matchPage(pages, clean);
        if (page && page.page.path !== NOT_FOUND) return { status: 301, headers: { location: `${clean}${url.search}`, 'cache-control': 'public, max-age=3600' }, body: '' };
      }
      if (!matched && matchPage(this.#refused.filter(r => r.path.startsWith('/')).map(r => ({ path: r.path }) as PageRow), pathname)) {
        return await this.#words(503, 'This page is not ready', 'This page is being made. Try again soon.', host, pathname);
      }
      if (!matched || matched.page.path === NOT_FOUND) return await this.#notFound(pages, host, pathname);
      const { page, params } = matched;
      // A template page answers only the slugs its collection holds; any other address is not a page (404), never a 502.
      const names = paramsOf(page.path);
      if (page.collection && names.length === 1 && !this.#slugs.get(page.collection)?.has(params[names[0]])) return await this.#notFound(pages, host, pathname);
      if (page.access === 'public') return await this.#drawn(page, params, host, pathname, call => this.#publicRun(call), 200, 'public, max-age=0, must-revalidate', url.searchParams, outcome);
      const member = await this.#parts.passes.memberOfCookie(cookie);
      if (member) return await this.#drawn(page, params, host, pathname, call => this.#parts.run(member.pass, call), 200, 'private, no-store', url.searchParams, outcome);
      const signIn = this.#parts.settings.sign_in;
      const drawnSignIn = signIn.signed_out === 'draw' ? matchPage(pages, signIn.page) : null;
      if (drawnSignIn && drawnSignIn.page.access === 'public') {
        return await this.#drawn(drawnSignIn.page, drawnSignIn.params, host, pathname, call => this.#publicRun(call), 200, 'private, no-store');
      }
      const next = `${url.pathname}${url.search}`;
      return { status: 302, headers: { location: `${signIn.page}?${new URLSearchParams({ next })}`, 'cache-control': 'private, no-store' }, body: '' };
    } catch (error) {
      const status = error instanceof DoorError && error.status === 403 ? 403 : 502;
      this.#log(`${method} ${pathname}: ${(error as Error).message}`);
      return status === 403
        ? this.#words(403, 'Not open to you', 'This page is not open to the account you are signed in with.', host, pathname)
        : this.#words(502, 'This page could not be drawn', 'Something this page reads did not answer. Try again in a minute.', host, pathname);
    }
  }
}

/** Each tool run's time, as the Server-Timing header writes it, so a slow page names its slow tool. */
export function serverTiming(timed: Timed[]): string {
  return timed.map((t, i) => `run${i};dur=${t.ms};desc="${t.tool.replace(/[^a-z0-9:-]/g, '')}"`).join(', ');
}

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer', 'content-length', 'host']);

export interface PassOn {
  name: string;
  address: string;
  paths?: string[];
  exact?: string[];
  hosts?: string[];
  /** Its HTML pages carry the site head (the consent default and bar, the site's tags) as the site's own pages do. */
  site_head?: boolean;
  /** Its paths are passed on before the site's own action and page rows, as exact paths always are. */
  first?: boolean;
  /**
   * Piped as it comes, both ways, nothing kept or waited for: every request header passes unchanged (Host, Authorization,
   * Mcp-Session-Id) and the answer streams back (an MCP door's event stream). Never with site_head.
   */
  stream?: boolean;
  /**
   * A browser's form post (a URL-encoded form, or a multipart form with no file in it) reaches this program as JSON: a dotted
   * name is a nested object (consent.billing), a repeated name a list, a whole number or decimal written plainly a number,
   * "true" and "false" booleans (formJsonOf). For a program made for its own page script's JSON, so a page drawn from rows
   * can post it a plain form. Never with stream.
   */
  form_as_json?: boolean;
}

// The other program is asked for its answer as it is (no compression), so it is passed back byte for byte with headers
// that describe it, and an HTML page can carry the site head.
const NOT_ASKED = new Set([...HOP, 'accept-encoding']);

const under = (pathname: string, path: string): boolean => pathname === path || pathname.startsWith(path.endsWith('/') ? path : `${path}/`);

/**
 * The program a request is passed on to, or null: a path is the path itself or one under it; exact is that path only. An exact
 * path, or a path under an entry marked first, is passed on whatever the site's own rows say. Otherwise a request the site's
 * own action rows answer (`acting`) is the site's, and with `pageFor` (the site's page row for the path) a page row under a
 * passed-on path answers instead (its row names the longer path), so a site takes an address over from another program one
 * row at a time.
 */
export function passOnFor(passOn: PassOn[], host: string, pathname: string, pageFor: (host: string, pathname: string) => string | null = () => null, acting = false): PassOn | null {
  const onHost = passOn.filter(entry => !entry.hosts?.length || entry.hosts.includes(host));
  const ahead = onHost.find(entry => (entry.exact ?? []).includes(pathname) || (entry.first === true && (entry.paths ?? []).some(path => under(pathname, path))));
  if (ahead) return ahead;
  if (acting) return null;
  const on = onHost.find(entry => (entry.paths ?? []).some(path => under(pathname, path))) ?? null;
  if (!on) return null;
  const page = pageFor(host, pathname);
  const longer = page !== null && (on.paths ?? []).some(path => under(pathname, path) && page.length > path.replace(/\/$/, '').length && under(page, path));
  return longer ? null : on;
}

/**
 * The network address a request came from: the last X-Forwarded-For entry, the one the site's own front web server added (a
 * visitor can write any earlier entry), else the connection's own address; null when neither is an address.
 */
export function networkOf(request: http.IncomingMessage): string | null {
  const forwarded = request.headers['x-forwarded-for'];
  const last = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '').split(',').map(entry => entry.trim()).filter(Boolean).at(-1);
  const address = last ?? request.socket.remoteAddress ?? '';
  return /^[0-9A-Fa-f:.]{2,45}$/.test(address) ? address : null;
}

/** A same-site path to send a visitor back to: the Referer's path and query, or the home page. */
export function backTo(referer: string | undefined): string {
  try {
    const url = new URL(String(referer));
    return url.protocol === 'https:' || url.protocol === 'http:' ? `${url.pathname}${url.search}` : '/';
  } catch {
    return '/';
  }
}

/** A browser's form post: POST of a form body by a page that takes HTML back. */
export function isBrowserFormPost(request: http.IncomingMessage): boolean {
  const type = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return request.method === 'POST' && (type === 'application/x-www-form-urlencoded' || type === 'multipart/form-data') && String(request.headers.accept ?? '').includes('text/html');
}

/**
 * What a browser's form post gets when the other program answered JSON (it was made for its own page script): a 2xx naming
 * an address (redirect, redirectUrl or url) is a 303 there; a 2xx naming none is passed as it is; a failure (4xx, 5xx) is the
 * page it came from drawn again with the site's words at the form, never the raw JSON. Null when it passes as it is.
 */
export async function formAnswerOf(answer: { status: number; headers: http.IncomingHttpHeaders; body: Buffer }, failedForm: (status: number) => Promise<Answer>): Promise<Answer | null> {
  if (!String(answer.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return null;
  if (answer.status >= 400) return failedForm(answer.status);
  let value: Record<string, unknown> | null = null;
  try { value = JSON.parse(answer.body.toString('utf8')) as Record<string, unknown>; } catch { value = null; }
  const to = value && typeof value === 'object' ? sendableAddress(value.redirect ?? value.redirectUrl ?? value.url) : null;
  return to ? { status: 303, headers: { location: to, 'cache-control': 'no-store' }, body: '' } : failedForm(502);
}

const PLAIN_NUMBER = /^-?(0|[1-9][0-9]{0,14})(\.[0-9]+)?$/;

/**
 * A form's fields as the JSON a page script would have sent: "a.b" is { a: { b } }, a name given twice is a list, a number
 * written plainly ("9900", "-1.5", never "007" or "1e3") a number, "true" and "false" booleans, anything else its text. Null
 * when the form cannot be JSON: a multipart form holding a file, or names that clash ("a" and "a.b").
 */
export async function formJsonOf(contentType: string | undefined, bytes: Buffer): Promise<Buffer | null> {
  let fields: [string, FormDataEntryValue][];
  try {
    fields = [...(await new Request('http://form.invalid/', { method: 'POST', headers: { 'content-type': String(contentType ?? '') }, body: bytes }).formData()).entries()];
  } catch {
    return null;
  }
  if (fields.some(([, value]) => typeof value !== 'string')) return null;
  const valueOf = (text: string): unknown => (PLAIN_NUMBER.test(text) ? Number(text) : text === 'true' ? true : text === 'false' ? false : text);
  const root: Record<string, unknown> = {};
  for (const [name, text] of fields as [string, string][]) {
    const parts = name.split('.');
    if (parts.some(part => part === '' || part === '__proto__' || part === 'constructor' || part === 'prototype')) return null;
    let at = root;
    for (const part of parts.slice(0, -1)) {
      const next = Object.hasOwn(at, part) ? at[part] : (at[part] = {});
      if (!next || typeof next !== 'object' || Array.isArray(next)) return null;
      at = next as Record<string, unknown>;
    }
    const last = parts[parts.length - 1];
    const value = valueOf(text);
    if (!Object.hasOwn(at, last)) at[last] = value;
    else if (Array.isArray(at[last])) (at[last] as unknown[]).push(value);
    else if (at[last] !== null && typeof at[last] === 'object') return null;
    else at[last] = [at[last], value];
  }
  return Buffer.from(JSON.stringify(root));
}

/**
 * One request passed whole to another program, and its answer passed back whole (its cookies too). A browser's form post is
 * never given raw JSON or a bare failure: when the program answers JSON, or does not answer, `failedForm` draws the answer
 * from the posted bytes.
 */
async function passOnTo(address: string, host: string, request: http.IncomingMessage, response: http.ServerResponse, head: SiteHeadMarkup | null, cookies: string[] = [], failedForm?: (status: number, bytes: Buffer) => Promise<Answer>, formAsJson = false): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) if (value !== undefined && !NOT_ASKED.has(name)) headers[name] = value;
  // A browser's form, to a program that reads JSON: the same fields as its own page script sends them.
  const asJson = formAsJson && isBrowserFormPost(request) ? await formJsonOf(request.headers['content-type'], bytes) : null;
  if (asJson) headers['content-type'] = 'application/json';
  headers['x-forwarded-host'] = host;
  headers['x-forwarded-proto'] = 'https';
  if (!address.startsWith('unix:')) headers.host = new URL(address).host;
  const asked = failedForm && isBrowserFormPost(request) ? (status: number) => failedForm(status, bytes) : null;
  const sendForm = (page: Answer, kept?: string | string[]): void => {
    response.writeHead(page.status, withCookies({ 'x-content-type-options': 'nosniff', ...page.headers, ...(kept ? { 'set-cookie': kept } : {}) }, cookies));
    response.end(page.body);
  };
  let answer: Awaited<ReturnType<typeof ask>>;
  try {
    answer = await ask(address, request.url ?? '/', { method: request.method ?? 'GET', headers, ...(asJson ? { body: asJson } : chunks.length ? { body: bytes } : {}) });
  } catch (error) {
    if (!asked) throw error;
    console.error(`${request.method} ${request.url}: ${address} did not answer: ${(error as Error).message}`);
    return sendForm(await asked(502));
  }
  const back: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(answer.headers)) if (value !== undefined && !HOP.has(name)) back[name] = value;
  // A browser's form post never gets raw JSON: a JSON answer becomes a 303 or the page it came from, drawn again.
  const asForm = asked ? await formAnswerOf(answer, asked) : null;
  if (asForm) return sendForm(asForm, back['set-cookie']);
  // A whole HTML document (one with a head and a body) carries the site head; a fragment or any other answer is passed as it is.
  const text = head !== null && String(answer.headers['content-type'] ?? '').startsWith('text/html') && !answer.headers['content-encoding'] ? answer.body.toString('utf8') : null;
  const whole = text !== null && text.includes(`${String.fromCharCode(60)}head>`) && new RegExp(`${String.fromCharCode(60)}body[^>]*>`).test(text);
  const body = whole ? Buffer.from(withSiteHead(text, head!)) : answer.body;
  response.writeHead(answer.status, withCookies(back, cookies));
  response.end(request.method === 'HEAD' ? undefined : body);
}

// The headers that belong to one connection, never passed through a stream.
const STREAM_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer']);

/**
 * One request piped to another program and its answer piped back as it comes (an MCP door, whose answers are event streams
 * and whose GET stays open): nothing is kept, every header but a connection's own passes unchanged both ways (Host too, so
 * the door answers for the name the visitor asked), and the other program's call ends when the visitor's does.
 */
function streamTo(address: string, host: string, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(request.headers)) if (value !== undefined && !STREAM_HOP.has(name)) headers[name] = value;
    headers['x-forwarded-host'] = host;
    headers['x-forwarded-proto'] = 'https';
    const path = request.url ?? '/';
    const target = address.startsWith('unix:')
      ? { socketPath: address.slice('unix:'.length), path }
      : (() => { const url = new URL(address); return { protocol: url.protocol, hostname: url.hostname, port: url.port, path }; })();
    const send = (target as { protocol?: string }).protocol === 'https:' ? https.request : http.request;
    const out = send({ ...target, method: request.method, headers }, answer => {
      const back: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(answer.headers)) if (value !== undefined && !STREAM_HOP.has(name)) back[name] = value;
      response.writeHead(answer.statusCode ?? 502, back);
      response.flushHeaders();
      answer.pipe(response);
      answer.on('end', () => resolve());
      answer.on('error', reject);
    });
    out.on('error', reject);
    response.on('close', () => { if (!response.writableFinished) out.destroy(); });
    request.pipe(out);
  });
}

/** A request's body, or null once it holds more than an action may. */
async function bytesOf(request: http.IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MOST_ACTION_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * An answer as the tool says it (an action row's reply): the status its value gives, each header whose value gives something,
 * and the answer's json keys as the body, or none. A status that is not a whole number from 100 to 599, a location that is not
 * an address a visitor may be sent to, or a header value with a line break or other control character fails the row. A failure
 * (400 to 599) the row gives no json keys for (a short link's 404) carries the row's own words as { error: failed }.
 */
async function replyOf(reply: ActionReply, answer: Record<string, unknown> | null, answered: Asked, failed: string): Promise<Answer> {
  const status = await filled(reply.status, answered);
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) throw new Error(`The reply's status gave ${JSON.stringify(status)}, not an HTTP status.`);
  const headers: Record<string, string | string[]> = { 'cache-control': 'no-store' };
  for (const [name, value] of Object.entries(reply.headers)) {
    const got = await filled(value, answered);
    if (got === undefined || got === null || got === '') continue;
    const values = (Array.isArray(got) ? got : [got]).map(item => (typeof item === 'number' ? String(item) : item));
    if (values.some(item => typeof item !== 'string' || !/^[\x20-\x7e]+$/.test(item))) throw new Error(`The reply's ${name} is not printable words on one line.`);
    if (name === 'location') {
      const to = sendableAddress(values[0]);
      if (!to || values.length !== 1) throw new Error('The reply\'s location is not one address a visitor may be sent to.');
      headers.location = to;
    } else headers[name] = name === 'set-cookie' ? values as string[] : (values as string[]).join(', ');
  }
  if (reply.json === null && status >= 400) return { status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } as Answer['headers'], body: JSON.stringify({ error: failed }) };
  if (reply.json === null) return { status, headers: headers as Answer['headers'], body: '' };
  return { status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } as Answer['headers'], body: JSON.stringify(Object.fromEntries(reply.json.map(key => [key, answer?.[key] ?? null]))) };
}

/** The program's node:http handler over a site. */
export function handlerOf(site: Site, passOn: PassOn[] = [], addressCookies: AddressCookie[] = []): http.RequestListener {
  return (request, response) => {
    const forwarded = request.headers['x-forwarded-host'];
    const host = site.hostOf(Array.isArray(forwarded) ? forwarded[0] : forwarded, request.headers.host);
    const pathname = new URL(request.url ?? '/', 'http://site.invalid').pathname;
    // What the arrival address carries (?ref=CODE) is kept on whichever program answers the page.
    const cookies = cookiesFromAddress(addressCookies, request.method ?? 'GET', request.url ?? '/', host);
    // A request the site's own action rows name is the site's, even under a path another program answers, unless that path is
    // passed on ahead of the site's rows (exact, or under an entry marked first).
    const method = request.method ?? 'GET';
    // A host a served_files rule closes answers only the files it names: anything else is 404, before pass_on and rows.
    if (site.closed(host, pathname)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' });
      response.end(method === 'HEAD' ? undefined : 'Not found\n');
      return;
    }
    const acting = site.acts(method, host, pathname);
    const on = passOnFor(passOn, host, pathname, method === 'GET' || method === 'HEAD' ? (h, p) => site.pageFor(h, p) : undefined, acting);
    if (on?.stream) {
      streamTo(on.address, host, request, response).catch(error => {
        console.error(`${request.method} ${request.url}: ${on.name} did not answer: ${(error as Error).message}`);
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end();
      });
      return;
    }
    if (on) {
      const failedForm = (status: number, bytes: Buffer) => site.failedForm(status, host, { action: pathname, words: null, referer: request.headers.referer, cookie: request.headers.cookie, values: formValuesOf(request.headers['content-type'], bytes) });
      passOnTo(on.address, host, request, response, on.site_head ? site.siteHead : null, cookies, failedForm, on.form_as_json === true).catch(error => {
        console.error(`${request.method} ${request.url}: ${on.name} did not answer: ${(error as Error).message}`);
        if (response.headersSent) return void response.end();
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end('This is not answering. Try again in a minute.\n');
      });
      return;
    }
    const answering = acting || method === 'POST'
      ? bytesOf(request).then(bytes => bytes === null
        ? { status: 413, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify({ error: 'Too large.' }) }
        : site.act(request.url ?? '/', request.headers.cookie, host, { method, contentType: request.headers['content-type'], origin: request.headers.origin, hostHeader: request.headers.host, referer: request.headers.referer, network: networkOf(request), headers: request.headers, bytes }))
      : site.answer(method, request.url ?? '/', request.headers.cookie, host, request.headers.range);
    answering
      .then(answer => {
        response.writeHead(answer.status, withCookies({ 'x-content-type-options': 'nosniff', ...answer.headers }, cookies));
        response.end(request.method === 'HEAD' ? undefined : answer.body);
      })
      .catch(error => {
        console.error(`${request.method} ${request.url}: ${(error as Error).message}`);
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end('This page could not be drawn.\n');
      });
  };
}

/** Listens on one socket or port: a socket left by the unit's last run is replaced; any other file there stops the start. */
function listenOn(server: http.Server, at: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (at.startsWith('unix:')) {
      const socket = at.slice('unix:'.length);
      if (existsSync(socket)) {
        if (!statSync(socket).isSocket()) return reject(new Error(`${socket} is not a socket, so it is left as it is.`));
        unlinkSync(socket);
      }
      server.listen(socket, () => { chmodSync(socket, 0o660); resolve(); });
    } else {
      const colon = at.lastIndexOf(':');
      server.listen(Number(at.slice(colon + 1)), at.slice(0, colon).replace(/^\[|\]$/g, ''), () => resolve());
    }
  });
}

/** Starts the site from its settings file: reads its rows once, then listens on each address of listen. */
export async function start(settingsFile: string): Promise<http.Server[]> {
  const settings = settingsOf(JSON.parse(readFileSync(settingsFile, 'utf8')));
  const tools = join(import.meta.dirname, '..', '..');
  const door: Door = { address: settings.door.address };
  const command = commandOf(door.address);
  const doorOp = join(tools, 'use-your-tools-from-a-shell', 'do-work', 'door-op.mjs');
  const byCommand: CommandDoor | null = command ? {
    command,
    pins: settings.door.pins ?? [],
    ...(settings.door.origin ? { origin: settings.door.origin } : {}),
    ...(settings.door.key_credential ? { key: credential(settings.door.key_credential) } : {}),
  } : null;
  const files = new ScreenFiles();
  const styles = await pageStyles(tools, files);
  const storeKey = settings.files_store ? storeKeyOf(credential(settings.files_store.credential)) : null;
  // Through a command the site's own reads carry the computer owner's rights; a member's pass is refused, never swapped for them.
  // As its OS user on the vault socket the same holds: the engine admits the site's uid, never a member's pass in its place.
  const peer = settings.door.peer === true;
  const runAs = command
    ? (pass: string, call: ToolRun) => pass === COMMAND_PASS ? runToolAsCommand(doorOp, byCommand!, call) : Promise.reject(new DoorError('A members page needs the engine door, not a command.', 403))
    : peer
      ? (pass: string, call: ToolRun) => pass === PEER_PASS ? runTool(door, '', call) : Promise.reject(new DoorError('A members page needs the engine door with the member\'s own pass, not the site\'s vault socket.', 403))
      : (pass: string, call: ToolRun) => runTool(door, pass, call);
  const run = (pass: string, call: ToolRun) => runAs(pass, withPagesUse(settings.pages.use, call));
  // The start's first reads (the rows through run-sql, the site head) are real tool runs with the site's own pass: a tool this
  // computer lacks, or a pass the door refuses, stops the start there with the door's own words. Nothing else is asked of the
  // door, so the pass needs no right beyond running the site's tools.
  const sitePass = command ? COMMAND_PASS : peer ? PEER_PASS : credential(settings.door.pass_credential!);
  const site = new Site({
    settings,
    tools,
    run,
    sitePass,
    passes: new MemberPasses(settings.sign_in),
    storeKey,
    // A settings row may name served files at any read, so the reader is there whenever the store is.
    storeFiles: (settings.served_files.length > 0 || settings.pages.settings !== undefined) && settings.files_store && storeKey ? new StoreFiles(settings.files_store, storeKey) : null,
    bundles: new PageBundles(tools, styles, files),
    palette: theme => styles.palette(theme),
    keepFont: async src => {
      const key = src.startsWith('/') && settings.files_store && settings.public_files ? publicKeyOf(settings.public_files, src) : null;
      if (src.startsWith('/') && (!key || !storeKey)) throw new Error(`The font ${src} is not a public file in the files store.`);
      const answer = await fetch(key ? presignedGet(settings.files_store!, storeKey!, key, 300, new Date()) : src, { signal: AbortSignal.timeout(30_000) });
      if (!answer.ok) throw new Error(`The font ${src} answered ${answer.status}.`);
      return files.keep(Buffer.from(await answer.arrayBuffer()), kindOf(src)!);
    },
    files,
    screens: screensOfTools(tools),
  });
  await site.read();
  const handler = handlerOf(site, settings.pass_on, settings.address_cookies);
  const servers = settings.listen.map(() => http.createServer(handler));
  await Promise.all(servers.map((server, i) => listenOn(server, settings.listen[i])));
  console.error(`serving ${site.pages.length} pages (${site.refused.length} rows set aside) of ${settings.origin} on ${settings.listen.join(', ')}`);
  return servers;
}

const started = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? '')).href === import.meta.url; } catch { return false; } })();
if (started) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node do-work/serve.ts <settings.json>');
    process.exit(2);
  }
  start(file).then(servers => {
    // A stop (SIGTERM, from a restart) drops nothing: each socket stops taking calls, the calls already taken finish, then the
    // program ends; a stop that takes longer than STOP_MS ends anyway, inside the unit's own stop time.
    process.once('SIGTERM', () => {
      console.error('stopping: finishing the calls already taken');
      setTimeout(() => process.exit(0), STOP_MS).unref();
      let open = servers.length;
      for (const server of servers) server.close(() => { open -= 1; if (open === 0) process.exit(0); });
    });
  }).catch(error => {
    console.error(`The site did not start: ${(error as Error).message}`);
    process.exit(1);
  });
}
