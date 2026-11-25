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
//                    credentials; or, for a local run on a person's own computer, address "cli:<command>" (that computer's
//                    own signed-in command runs each read, with the pins given, and no pass is held). A members page is
//                    never drawn through a command: it needs the member's own pass on the door.
//     pages          { database, use: { purpose, surface }, refresh_seconds, answer_seconds }: the database holding the
//                    `pages` and `site_look` tables, the declared use its reads run under (the reader login; left out, the
//                    caller's own login, which only a local run through a command should do), how often the rows
//                    are read again, and how long a public page's tool answer is kept
//     sign_in        { address, page, issuer, audience, team_claim, members_team }: the site's sign-in tool, the site path a
//                    visitor is sent to for a members page, and how a member's pass is checked (member-pass.ts);
//                    signed_out "redirect" (302 to page?next=<address>, when left out) or "draw" (the page row at `page` is
//                    drawn at the members address itself, 200, private, no-store)
//     pass_on        [{ name, address, paths, exact, hosts }]: other programs that answer some of the site's addresses
//                    themselves (the sign-in tool's pages and /api/auth; a program's actions that have no tool yet): a request
//                    under one of `paths`, or at one of `exact`, on one of `hosts` (every host when left out), is passed to
//                    `address` whole, its answer passed back whole; the first entry that takes it wins
//     actions        (optional) the table of the site's action rows (actions.ts), read with the pages
//     site_head      (optional) { tool, input }: the tool whose answer { head, body_start } every page carries at the top of its
//                    <head> and the start of its <body> (the consent default and bar, then the site's declared tags; the
//                    Workshop's tool:read-the-site-head), read with the rows and placed by that tool's own withSiteHead
//     files_store    (optional) { endpoint, region, bucket, style, credential }: the site's files store, and the name of its read
//                    key in the unit's credentials (member-video.ts)
//     member_files   (optional, needs files_store) { path, key_prefix, prefixes, link_seconds }: members' files
//     public_files   (optional, needs files_store) { paths, key_prefix, link_seconds, cache_seconds }: the site's public files
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
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ask, commandOf, DoorError, runTool, runToolAsCommand } from './door.ts';
import type { Door, ToolRun } from './door.ts';
import { MemberPasses } from './member-pass.ts';
import type { Member, SignIn } from './member-pass.ts';
import { filesStoreOf, isPublicPath, memberFileAnswer, memberFilesOf, objectKeyOf, presignedGet, publicFileAnswer, publicFilesOf, publicKeyOf, storeKeyOf } from './member-video.ts';
import type { FilesStore, MemberFiles, PublicFiles, StoreKey } from './member-video.ts';
import { filledInput, matchPage, pagesOf, pagesOn, pathWith, PAGES_SQL, paramsOf, slugsSql } from './pages.ts';
import type { PageRow, Refused } from './pages.ts';
import { actionsOf, actionsSql, bodyOf, cookiesOf, filled, matchAction, sendableAddress, setCookieOf } from './actions.ts';
import type { ActionRow, Asked } from './actions.ts';
import { pageStyles } from './page-styles.ts';
import { withSiteHead } from '../../site-head-from-its-rows/do-work/site-head.ts';
import type { SiteHeadMarkup } from '../../site-head-from-its-rows/do-work/site-head.ts';
import { drawnTreeOf, fontFaceCss, fontFacesOf, lookCss, PageBundles, screensOfTools, THEME_ROW, treeOf, wordsTree } from './render.ts';
import type { Screen, Timed } from './render.ts';
import { modulesOf } from './render-layout.ts';
import type { DrawnNode } from './render-layout.ts';
import { kindOf, ScreenFiles } from './screen-files.ts';
import type { Answer } from './screen-files.ts';

export interface Settings {
  listen: string[];
  origin: string;
  hosts: string[];
  lang: string;
  door: { address: string; pass_credential?: string; pins?: string[] };
  pages: { database: string; use?: { purpose: string; surface: string }; refresh_seconds: number; answer_seconds: number };
  sign_in: SignIn & { page: string; signed_out: 'redirect' | 'draw' };
  pass_on: PassOn[];
  site_head?: { tool: string; input: Record<string, unknown> };
  actions?: string;
  files_store?: FilesStore & { credential: string };
  member_files?: MemberFiles;
  public_files?: PublicFiles;
}

const RUN_SQL = 'tool:run-sql-in-my-database';
const LOOK_SQL = 'SELECT name, value FROM site_look ORDER BY name';
const MOST_KEPT_ANSWERS = 1000;
/** The most bytes an action's posted body may hold. */
export const MOST_ACTION_BYTES = 65536;
/** The longest a stop waits for the calls already taken, inside a unit's 30 s stop time. */
const STOP_MS = 25_000;
const NOT_FOUND = '/404';
export const LOCAL_LISTEN = '127.0.0.1:18440';
// Stands for the site's own caller when reads go through a command: no pass is held then.
const COMMAND_PASS = 'the computer\'s own command';
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
  if (!s.door || typeof s.door.address !== 'string' || (!byCommand && typeof s.door.pass_credential !== 'string')
    || (s.door.pins !== undefined && (!Array.isArray(s.door.pins) || s.door.pins.some(pin => typeof pin !== 'string')))) {
    throw new Error('door is { address, pass_credential } (or { address: "cli:<command>", pins } for a local run).');
  }
  const p = s.pages;
  if (!p || typeof p.database !== 'string' || (p.use !== undefined && (!p.use || typeof p.use.purpose !== 'string' || typeof p.use.surface !== 'string'))
    || !Number.isInteger(p.refresh_seconds) || p.refresh_seconds < 1 || !Number.isInteger(p.answer_seconds) || p.answer_seconds < 0) {
    throw new Error('pages is { database, use?: { purpose, surface }, refresh_seconds (1 or more), answer_seconds (0 or more) }.');
  }
  const i = s.sign_in;
  if (!i || ['address', 'page', 'issuer', 'audience', 'team_claim', 'members_team'].some(key => typeof (i as unknown as Record<string, unknown>)[key] !== 'string') || !i.page.startsWith('/')) {
    throw new Error('sign_in is { address, page (a site path), issuer, audience, team_claim, members_team }.');
  }
  if (i.signed_out !== 'redirect' && i.signed_out !== 'draw') throw new Error('sign_in.signed_out is "redirect" or "draw".');
  const sitePath = (path: unknown) => typeof path === 'string' && /^\/[A-Za-z0-9._~\/-]*$/.test(path);
  if (!Array.isArray(s.pass_on) || s.pass_on.some(on => !on || typeof on.name !== 'string' || typeof on.address !== 'string'
    || !(Array.isArray(on.paths ?? []) && (on.paths ?? []).every(sitePath)) || !(Array.isArray(on.exact ?? []) && (on.exact ?? []).every(sitePath))
    || !(Array.isArray(on.hosts ?? []) && (on.hosts ?? []).every(host => typeof host === 'string' && HOST_NAME.test(host)))
    || (on.site_head !== undefined && typeof on.site_head !== 'boolean'))) {
    throw new Error('pass_on lists { name, address, paths (a path and what is under it), exact (that path only), hosts (only these hosts; every host when left out), site_head (true: its pages carry the site head too) }.');
  }
  if (s.site_head !== undefined && (!s.site_head || typeof s.site_head.tool !== 'string' || !s.site_head.tool.startsWith('tool:')
    || !s.site_head.input || typeof s.site_head.input !== 'object' || Array.isArray(s.site_head.input))) {
    throw new Error('site_head is { tool: "tool:<id>", input: { ... } }: the tool whose answer { head, body_start } every page carries.');
  }
  if (s.actions !== undefined && (typeof s.actions !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(s.actions))) throw new Error('actions is the table name of the site\'s action rows, such as "site_actions".');
  if (s.files_store !== undefined) {
    filesStoreOf(s.files_store);
    if (typeof s.files_store.credential !== 'string') throw new Error('files_store.credential names the store\'s read key in the unit\'s credentials.');
  }
  if ((s.member_files !== undefined || s.public_files !== undefined) && s.files_store === undefined) throw new Error('member_files and public_files need files_store.');
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
  piped.value ??= readFileSync(0, 'utf8').trim();
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
  #head: SiteHeadMarkup | null = null;
  #readAt = 0;
  #reading: Promise<void> | null = null;
  #answers = new Map<string, Kept>();
  #log: (line: string) => void;

  constructor(parts: SiteParts) {
    this.#parts = parts;
    this.#log = parts.log ?? (line => console.error(line));
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

  /** Reads the page and look rows; throws when they cannot be read or a row is broken. */
  async read(): Promise<void> {
    const table = this.#parts.settings.actions;
    const [pages, look, head, actionRows] = await Promise.all([this.#sql(PAGES_SQL), this.#sql(LOOK_SQL), this.#siteHead(), table ? this.#sql(actionsSql(table)) : []]);
    const { actions, refused: refusedActions } = actionsOf(actionRows);
    for (const { path, why } of refusedActions) if (!this.#refusedActions.some(r => r.path === path && r.why === why)) this.#log(`action row set aside: ${why}`);
    const { pages: good, refused } = pagesOf(pages);
    for (const { path, why } of refused) if (!this.#refused.some(r => r.path === path && r.why === why)) this.#log(`page row set aside: ${why}`);
    const collections = [...new Set(good.filter(page => page.collection && paramsOf(page.path).length === 1).map(page => page.collection!))];
    const slugs = new Map(await Promise.all(collections.map(async collection => [collection,
      new Set((await this.#sql(slugsSql(collection))).map(row => row.slug).filter((slug): slug is string => typeof slug === 'string' && slug !== ''))] as const)));
    this.#pages = good;
    this.#slugs = slugs;
    this.#actions = actions;
    this.#refusedActions = refusedActions;
    this.#refused = refused;
    const theme = look.find(row => row.name === THEME_ROW)?.value;
    const faces = await Promise.all(fontFacesOf(look).map(async face => ({ ...face, address: await this.#parts.keepFont(face.src) })));
    this.#look = `${fontFaceCss(faces)}${this.#parts.palette(typeof theme === 'string' ? theme : null)}${lookCss(look)}`;
    this.#head = head;
    this.#readAt = Date.now();
  }

  // The site head's markup, read by its tool with the rows; a site with no site_head carries none.
  async #siteHead(): Promise<SiteHeadMarkup | null> {
    const call = this.#parts.settings.site_head;
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

  async #document(title: string, host: string, pathname: string, tree: DrawnNode, goTo?: string): Promise<string> {
    const bundle = await this.#parts.bundles.bundleFor(modulesOf(tree));
    const html = bundle.html({ lang: this.#parts.settings.lang, title, canonical: `${this.#originOf(host)}${pathname}`, look: this.#look, ...(goTo ? { goTo } : {}) }, tree);
    return this.#head ? withSiteHead(html, this.#head) : html;
  }

  async #drawn(page: PageRow, params: Record<string, string>, host: string, pathname: string, run: (call: ToolRun) => Promise<unknown>, status: number, cache: string, query = new URLSearchParams()): Promise<Answer> {
    if (page.layout && 'go_to' in page.layout) {
      const goTo = pathWith(page.layout.go_to, params);
      const body = await this.#document(page.title ?? goTo, host, pathname, wordsTree(page.title ?? '', goTo), goTo);
      return { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': cache }, body };
    }
    const { drawn, timed, answerOf } = await drawnTreeOf(treeOf(page, params, query), this.#parts.screens, run);
    const answered = page.tool ? answerOf({ tool: page.tool, input: filledInput(page.input, params, query) })?.title : undefined;
    const title = page.title ?? (typeof answered === 'string' && answered.trim() ? answered : null);
    if (title === null) throw new Error(`page ${page.path}: its row has no title and ${page.tool} answered none.`);
    const body = await this.#document(title, host, pathname, drawn);
    return { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': cache, 'server-timing': serverTiming(timed) }, body };
  }

  async #words(status: number, heading: string, words: string, host: string, pathname: string): Promise<Answer> {
    const body = await this.#document(heading, host, pathname, wordsTree(heading, words));
    return { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body };
  }

  async #notFound(pages: PageRow[], host: string, pathname: string): Promise<Answer> {
    const page = pages.find(row => row.path === NOT_FOUND && row.access === 'public');
    if (page) return this.#drawn(page, {}, host, pathname, call => this.#publicRun(call), 404, 'no-store');
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

  /** True when an action row answers this method at this host and path. */
  acts(method: string, host: string, pathname: string): boolean {
    return matchAction(this.#actions, method, host, pathname) !== null;
  }

  /**
   * The answer for one action: the action row for the method, host and path, its tool run with the input made from the
   * request (as the member when one is signed in, else as the site), and the row's answer. A form post is sent on with 303;
   * a JSON post gets JSON ({ "redirect": address } for a redirect). A GET (no body) gets the JSON keys, or is sent on with 303.
   */
  async act(address: string, cookie: string | undefined, host: string, request: { method?: string; contentType?: string; origin?: string; hostHeader?: string; bytes: Buffer }): Promise<Answer> {
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
    const member = await this.#parts.passes.memberOfCookie(cookie);
    if (action.access === 'members' && !member) return json(403, { error: 'Sign in as a member first.' });
    const failed = async (status: number): Promise<Answer> => (posted.form ? this.#words(status, 'That did not go through', action.failed, host, pathname) : json(status, { error: action.failed }));
    try {
      const asked: Asked = {
        body: posted.body, params, query: url.searchParams, cookies: cookiesOf(cookie), claims: member?.claims ?? null, origin: this.#originOf(host),
        rows: (sql, values, database) => this.#sql(sql, values, database), answer: null, input: null,
      };
      const input = await filled(action.input, asked);
      const answer = await this.#parts.run(member ? member.pass : this.#parts.sitePass, { tool: action.tool, input }) as Record<string, unknown> | null;
      const answered: Asked = { ...asked, answer, input };
      const setCookie = action.answer.cookie ? setCookieOf(action.answer.cookie, await filled(action.answer.cookie.value, answered), asked.cookies) : null;
      const withCookie = (sent: Answer): Answer => (setCookie ? { ...sent, headers: { ...sent.headers, 'set-cookie': setCookie } } : sent);
      if ('json' in action.answer) return withCookie(json(200, Object.fromEntries(action.answer.json.map(key => [key, answer?.[key] ?? null]))));
      const to = sendableAddress('redirect_from' in action.answer ? answer?.[action.answer.redirect_from] : await filled(action.answer.redirect_to, answered));
      if (!to) throw new Error(`${action.tool} answered no address to send the visitor to.`);
      return withCookie(posted.form ? { status: 303, headers: { location: to, 'cache-control': 'no-store' }, body: '' } : json(200, { redirect: to }));
    } catch (error) {
      this.#log(`${method} ${pathname}: ${(error as Error).message}`);
      return failed(error instanceof DoorError && error.status === 403 ? 403 : 502);
    }
  }

  /** The answer for one request: its method, its address (path and query), its cookie and its host (hostOf). */
  async answer(method: string, address: string, cookie: string | undefined, host = this.hostOf(undefined, undefined)): Promise<Answer> {
    const url = new URL(address, 'http://site.invalid');
    const pathname = url.pathname;
    if (method !== 'GET' && method !== 'HEAD') return { status: 405, headers: { allow: 'GET, HEAD, POST', 'content-type': 'text/plain; charset=utf-8' }, body: 'This address answers GET and HEAD, and POST where the site does something.\n' };
    const file = this.#parts.files.answer(pathname);
    if (file) return file;
    this.#fresh();
    const { files_store: store, member_files: memberFiles, public_files: publicFiles } = this.#parts.settings;
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
      if (!matched && matchPage(this.#refused.filter(r => r.path.startsWith('/')).map(r => ({ path: r.path }) as PageRow), pathname)) {
        return await this.#words(503, 'This page is not ready', 'This page is being made. Try again soon.', host, pathname);
      }
      if (!matched || matched.page.path === NOT_FOUND) return await this.#notFound(pages, host, pathname);
      const { page, params } = matched;
      // A template page answers only the slugs its collection holds; any other address is not a page (404), never a 502.
      const names = paramsOf(page.path);
      if (page.collection && names.length === 1 && !this.#slugs.get(page.collection)?.has(params[names[0]])) return await this.#notFound(pages, host, pathname);
      if (page.access === 'public') return await this.#drawn(page, params, host, pathname, call => this.#publicRun(call), 200, 'public, max-age=0, must-revalidate', url.searchParams);
      const member = await this.#parts.passes.memberOfCookie(cookie);
      if (member) return await this.#drawn(page, params, host, pathname, call => this.#parts.run(member.pass, call), 200, 'private, no-store', url.searchParams);
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
}

// The other program is asked for its answer as it is (no compression), so it is passed back byte for byte with headers
// that describe it, and an HTML page can carry the site head.
const NOT_ASKED = new Set([...HOP, 'accept-encoding']);

/** The program a request is passed on to, or null: a path is the path itself or one under it; exact is that path only. */
export function passOnFor(passOn: PassOn[], host: string, pathname: string): PassOn | null {
  return passOn.find(on => (!on.hosts?.length || on.hosts.includes(host))
    && ((on.exact ?? []).includes(pathname) || (on.paths ?? []).some(path => pathname === path || pathname.startsWith(path.endsWith('/') ? path : `${path}/`)))) ?? null;
}

/** One request passed whole to another program, and its answer passed back whole (its cookies too). */
async function passOnTo(address: string, host: string, request: http.IncomingMessage, response: http.ServerResponse, head: SiteHeadMarkup | null): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) if (value !== undefined && !NOT_ASKED.has(name)) headers[name] = value;
  headers['x-forwarded-host'] = host;
  headers['x-forwarded-proto'] = 'https';
  if (!address.startsWith('unix:')) headers.host = new URL(address).host;
  const answer = await ask(address, request.url ?? '/', { method: request.method ?? 'GET', headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
  const back: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(answer.headers)) if (value !== undefined && !HOP.has(name)) back[name] = value;
  // A whole HTML document (one with a head and a body) carries the site head; a fragment or any other answer is passed as it is.
  const text = head !== null && String(answer.headers['content-type'] ?? '').startsWith('text/html') && !answer.headers['content-encoding'] ? answer.body.toString('utf8') : null;
  const whole = text !== null && text.includes(`${String.fromCharCode(60)}head>`) && new RegExp(`${String.fromCharCode(60)}body[^>]*>`).test(text);
  const body = whole ? Buffer.from(withSiteHead(text, head!)) : answer.body;
  response.writeHead(answer.status, back);
  response.end(request.method === 'HEAD' ? undefined : body);
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

/** The program's node:http handler over a site. */
export function handlerOf(site: Site, passOn: PassOn[] = []): http.RequestListener {
  return (request, response) => {
    const forwarded = request.headers['x-forwarded-host'];
    const host = site.hostOf(Array.isArray(forwarded) ? forwarded[0] : forwarded, request.headers.host);
    const pathname = new URL(request.url ?? '/', 'http://site.invalid').pathname;
    // A request the site's own action rows name is the site's, even under a path another program answers.
    const method = request.method ?? 'GET';
    const acting = site.acts(method, host, pathname);
    const on = acting ? null : passOnFor(passOn, host, pathname);
    if (on) {
      passOnTo(on.address, host, request, response, on.site_head ? site.siteHead : null).catch(error => {
        console.error(`${request.method} ${request.url}: ${on.name} did not answer: ${(error as Error).message}`);
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end('This is not answering. Try again in a minute.\n');
      });
      return;
    }
    const answering = acting || method === 'POST'
      ? bytesOf(request).then(bytes => bytes === null
        ? { status: 413, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify({ error: 'Too large.' }) }
        : site.act(request.url ?? '/', request.headers.cookie, host, { method, contentType: request.headers['content-type'], origin: request.headers.origin, hostHeader: request.headers.host, bytes }))
      : site.answer(method, request.url ?? '/', request.headers.cookie, host);
    answering
      .then(answer => {
        response.writeHead(answer.status, { 'x-content-type-options': 'nosniff', ...answer.headers });
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
  const files = new ScreenFiles();
  const styles = await pageStyles(tools, files);
  const storeKey = settings.files_store ? storeKeyOf(credential(settings.files_store.credential)) : null;
  // Through a command the site's own reads carry the computer owner's rights; a member's pass is refused, never swapped for them.
  const run = command
    ? (pass: string, call: ToolRun) => pass === COMMAND_PASS ? runToolAsCommand(doorOp, command, settings.door.pins ?? [], call) : Promise.reject(new DoorError('A members page needs the engine door, not a command.', 403))
    : (pass: string, call: ToolRun) => runTool(door, pass, call);
  const site = new Site({
    settings,
    tools,
    run,
    sitePass: command ? COMMAND_PASS : credential(settings.door.pass_credential!),
    passes: new MemberPasses(settings.sign_in),
    storeKey,
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
  const handler = handlerOf(site, settings.pass_on);
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
