// tools/serve-a-sites-pages-from-its-rows/do-work/serve.ts
//
// PURPOSE
//   One kept-running program serves a whole site from its rows: `node do-work/serve.ts <settings.json>`. Its computer row runs
//   it as a unit behind the computer's front web server (tool:start-a-computer), which passes it the site's requests on the
//   socket or port the settings name. For each request it answers, in this order:
//     /screen-files/<identity>.<js|css>   a page's mount script or stylesheet (screen-files.ts)
//     <member_files.path><key>            a member's file: 302 to a presigned link, for members only (member-video.ts)
//     /sitemap.xml                        every public page address, template pages listed from their collection
//     a page row's address                the page (pages.ts, render.ts); a members page only for a member
//   and the page row "/404" (or plain words) for any other address. Its pages, look and tool answers are read through the
//   engine's door (door.ts) as a caller: the site's own pass for public pages, the member's own pass for members pages.
//
//   Settings (one JSON file, made by the computer row; nothing secret in it):
//     listen         "unix:/run/<unit>/site.sock" or "127.0.0.1:<port>"
//     origin         the site's address, such as https://example.com (canonical addresses, the sitemap)
//     lang           the pages' language, such as "en"
//     door           { address, pass_credential }: the engine door, and the name of the site's pass in the unit's credentials
//     pages          { database, use: { purpose, surface }, refresh_seconds, answer_seconds }: the database holding the
//                    `pages` and `site_look` tables, the declared use its reads run under (the reader login), how often the rows
//                    are read again, and how long a public page's tool answer is kept
//     sign_in        { address, page, issuer, audience, team_claim, members_team }: the site's sign-in tool, the site path a
//                    visitor is sent to for a members page, and how a member's pass is checked (member-pass.ts)
//     member_files   (optional) member-video.ts's settings, plus `credential`: the name of the store's read key in the unit's
//                    credentials
//   Credentials are files of the unit's credentials folder ($CREDENTIALS_DIRECTORY), sealed there by the computer from the vault.
//
// NON-NEGOTIABLE INVARIANTS
//   1. It holds no database login: every row is read by the engine's run-sql tool, as the site's caller, under a declared use.
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
import { DoorError, runTool } from './door.ts';
import type { Door, ToolRun } from './door.ts';
import { MemberPasses } from './member-pass.ts';
import type { Member, SignIn } from './member-pass.ts';
import { memberFileAnswer, memberFilesOf, objectKeyOf, storeKeyOf } from './member-video.ts';
import type { MemberFiles, StoreKey } from './member-video.ts';
import { matchPage, pagesOf, pathWith, PAGES_SQL, paramsOf, slugsSql } from './pages.ts';
import type { PageRow } from './pages.ts';
import { pageStyles } from './page-styles.ts';
import { drawnTreeOf, lookCss, PageBundles, screensOfTools, treeOf, wordsTree } from './render.ts';
import type { Screen, Timed } from './render.ts';
import { modulesOf } from './render-layout.ts';
import type { DrawnNode } from './render-layout.ts';
import { ScreenFiles } from './screen-files.ts';
import type { Answer } from './screen-files.ts';

export interface Settings {
  listen: string;
  origin: string;
  lang: string;
  door: { address: string; pass_credential: string };
  pages: { database: string; use: { purpose: string; surface: string }; refresh_seconds: number; answer_seconds: number };
  sign_in: SignIn & { page: string };
  member_files?: MemberFiles & { credential: string };
}

const RUN_SQL = 'tool:run-sql-in-my-database';
const LOOK_SQL = 'SELECT name, value FROM site_look ORDER BY name';
const MOST_KEPT_ANSWERS = 1000;
const NOT_FOUND = '/404';

/** Checks a settings file's value; a wrong one throws with what it should be. */
export function settingsOf(value: unknown): Settings {
  const s = value as Partial<Settings> | null;
  if (!s || typeof s.listen !== 'string' || !/^(unix:\/.+|[0-9.]+:\d+|\[[0-9a-f:]+\]:\d+)$/i.test(s.listen)) throw new Error('listen is "unix:/path/to.sock" or "host:port".');
  if (typeof s.origin !== 'string' || !/^https?:\/\/[^/]+$/.test(s.origin)) throw new Error('origin is the site\'s address, such as https://example.com.');
  if (typeof s.lang !== 'string' || !/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(s.lang)) throw new Error('lang is a language tag, such as "en".');
  if (!s.door || typeof s.door.address !== 'string' || typeof s.door.pass_credential !== 'string') throw new Error('door is { address, pass_credential }.');
  const p = s.pages;
  if (!p || typeof p.database !== 'string' || !p.use || typeof p.use.purpose !== 'string' || typeof p.use.surface !== 'string'
    || !Number.isInteger(p.refresh_seconds) || p.refresh_seconds < 1 || !Number.isInteger(p.answer_seconds) || p.answer_seconds < 0) {
    throw new Error('pages is { database, use: { purpose, surface }, refresh_seconds (1 or more), answer_seconds (0 or more) }.');
  }
  const i = s.sign_in;
  if (!i || ['address', 'page', 'issuer', 'audience', 'team_claim', 'members_team'].some(key => typeof (i as unknown as Record<string, unknown>)[key] !== 'string') || !i.page.startsWith('/')) {
    throw new Error('sign_in is { address, page (a site path), issuer, audience, team_claim, members_team }.');
  }
  if (s.member_files !== undefined) {
    memberFilesOf(s.member_files);
    if (typeof s.member_files.credential !== 'string') throw new Error('member_files.credential names the store\'s read key in the unit\'s credentials.');
  }
  return s as Settings;
}

/** One credential of the unit, by name, from its credentials folder. */
export function credential(name: string, folder = process.env.CREDENTIALS_DIRECTORY): string {
  if (!folder || !/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`The credential ${name} is not in this unit's credentials.`);
  return readFileSync(join(folder, name), 'utf8').trim();
}

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
  files: ScreenFiles;
  screens: Map<string, Screen>;
  log?: (line: string) => void;
}

interface Kept { at: number; answer: unknown }

const xml = (text: string): string => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

export class Site {
  #parts: SiteParts;
  #pages: PageRow[] = [];
  #look = '';
  #readAt = 0;
  #reading: Promise<void> | null = null;
  #answers = new Map<string, Kept>();
  #log: (line: string) => void;

  constructor(parts: SiteParts) {
    this.#parts = parts;
    this.#log = parts.log ?? (line => console.error(line));
  }

  #sql(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const { database, use } = this.#parts.settings.pages;
    return this.#parts.run(this.#parts.sitePass, { tool: RUN_SQL, input: { database, sql, params, use } })
      .then(answer => {
        const rows = (answer as { rows?: unknown } | null)?.rows;
        if (!Array.isArray(rows)) throw new DoorError(`${RUN_SQL} answered no rows.`);
        return rows as Record<string, unknown>[];
      });
  }

  /** Reads the page and look rows; throws when they cannot be read or a row is broken. */
  async read(): Promise<void> {
    const [pages, look] = await Promise.all([this.#sql(PAGES_SQL), this.#sql(LOOK_SQL)]);
    this.#pages = pagesOf(pages);
    this.#look = lookCss(look);
    this.#readAt = Date.now();
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

  async #document(title: string, pathname: string, tree: DrawnNode): Promise<string> {
    const bundle = await this.#parts.bundles.bundleFor(modulesOf(tree));
    const { lang, origin } = this.#parts.settings;
    return bundle.html({ lang, title, canonical: `${origin}${pathname}`, look: this.#look }, tree);
  }

  async #words(status: number, heading: string, words: string, pathname: string): Promise<Answer> {
    const body = await this.#document(heading, pathname, wordsTree(heading, words));
    return { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body };
  }

  async #notFound(pathname: string): Promise<Answer> {
    const page = this.#pages.find(row => row.path === NOT_FOUND && row.access === 'public');
    if (page) {
      const drawn = await drawnTreeOf(treeOf(page, {}), this.#parts.screens, call => this.#publicRun(call));
      return { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: await this.#document(page.title, pathname, drawn.drawn) };
    }
    return this.#words(404, 'Not found', 'There is no page at this address.', pathname);
  }

  async #sitemap(): Promise<Answer> {
    const { origin } = this.#parts.settings;
    const entries: { loc: string; lastmod: string | null }[] = [];
    for (const page of this.#pages.filter(row => row.access === 'public' && row.path !== NOT_FOUND)) {
      const names = paramsOf(page.path);
      if (!names.length) { entries.push({ loc: `${origin}${page.path}`, lastmod: page.updated_at }); continue; }
      if (names.length !== 1 || !page.collection) continue;
      for (const row of await this.#sql(slugsSql(page.collection))) {
        if (typeof row.slug === 'string' && row.slug) entries.push({ loc: `${origin}${pathWith(page.path, { [names[0]]: row.slug })}`, lastmod: page.updated_at });
      }
    }
    const urls = entries.map(({ loc, lastmod }) => `<url><loc>${xml(loc)}</loc>${lastmod ? `<lastmod>${xml(lastmod.slice(0, 10))}</lastmod>` : ''}</url>`).join('\n');
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
    return { status: 200, headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=300' }, body };
  }

  /** The answer for one request: its method, its address (path and query) and its cookie. */
  async answer(method: string, address: string, cookie: string | undefined): Promise<Answer> {
    const url = new URL(address, 'http://site.invalid');
    const pathname = url.pathname;
    if (method !== 'GET' && method !== 'HEAD') return { status: 405, headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }, body: 'This address answers GET and HEAD.\n' };
    const file = this.#parts.files.answer(pathname);
    if (file) return file;
    this.#fresh();
    const memberFiles = this.#parts.settings.member_files;
    if (memberFiles && pathname.startsWith(memberFiles.path)) {
      const key = objectKeyOf(memberFiles, pathname);
      if (!key || !this.#parts.storeKey) return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' }, body: 'No such file.\n' };
      return memberFileAnswer(memberFiles, this.#parts.storeKey, key, await this.#parts.passes.memberOfCookie(cookie));
    }
    try {
      if (pathname === '/sitemap.xml') return await this.#sitemap();
      const matched = matchPage(this.#pages, pathname);
      if (!matched || matched.page.path === NOT_FOUND) return await this.#notFound(pathname);
      const { page, params } = matched;
      let run = (call: ToolRun) => this.#publicRun(call);
      let cache = 'public, max-age=0, must-revalidate';
      if (page.access === 'members') {
        const member = await this.#parts.passes.memberOfCookie(cookie);
        if (!member) {
          const next = `${url.pathname}${url.search}`;
          return { status: 302, headers: { location: `${this.#parts.settings.sign_in.page}?${new URLSearchParams({ next })}`, 'cache-control': 'private, no-store' }, body: '' };
        }
        run = call => this.#parts.run(member.pass, call);
        cache = 'private, no-store';
      }
      const { drawn, timed } = await drawnTreeOf(treeOf(page, params), this.#parts.screens, run);
      const body = await this.#document(page.title, pathname, drawn);
      return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': cache, 'server-timing': serverTiming(timed) }, body };
    } catch (error) {
      const status = error instanceof DoorError && error.status === 403 ? 403 : 502;
      this.#log(`${method} ${pathname}: ${(error as Error).message}`);
      return status === 403
        ? this.#words(403, 'Not open to you', 'This page is not open to the account you are signed in with.', pathname)
        : this.#words(502, 'This page could not be drawn', 'Something this page reads did not answer. Try again in a minute.', pathname);
    }
  }
}

/** Each tool run's time, as the Server-Timing header writes it, so a slow page names its slow tool. */
export function serverTiming(timed: Timed[]): string {
  return timed.map((t, i) => `run${i};dur=${t.ms};desc="${t.tool.replace(/[^a-z0-9:-]/g, '')}"`).join(', ');
}

/** The program's node:http handler over a site. */
export function handlerOf(site: Site): http.RequestListener {
  return (request, response) => {
    site.answer(request.method ?? 'GET', request.url ?? '/', request.headers.cookie)
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

/** Starts the site from its settings file: reads its rows once, then listens. */
export async function start(settingsFile: string): Promise<http.Server> {
  const settings = settingsOf(JSON.parse(readFileSync(settingsFile, 'utf8')));
  const tools = join(import.meta.dirname, '..', '..');
  const door: Door = { address: settings.door.address };
  const files = new ScreenFiles();
  const site = new Site({
    settings,
    tools,
    run: (pass, call) => runTool(door, pass, call),
    sitePass: credential(settings.door.pass_credential),
    passes: new MemberPasses(settings.sign_in),
    storeKey: settings.member_files ? storeKeyOf(credential(settings.member_files.credential)) : null,
    bundles: new PageBundles(tools, await pageStyles(tools, files), files),
    files,
    screens: screensOfTools(tools),
  });
  await site.read();
  const server = http.createServer(handlerOf(site));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (settings.listen.startsWith('unix:')) {
      const socket = settings.listen.slice('unix:'.length);
      // A socket left by the unit's last run is replaced; any other file there stops the start.
      if (existsSync(socket)) {
        if (!statSync(socket).isSocket()) throw new Error(`${socket} is not a socket, so it is left as it is.`);
        unlinkSync(socket);
      }
      server.listen(socket, () => { chmodSync(socket, 0o660); resolve(); });
    } else {
      const at = settings.listen.lastIndexOf(':');
      server.listen(Number(settings.listen.slice(at + 1)), settings.listen.slice(0, at).replace(/^\[|\]$/g, ''), () => resolve());
    }
  });
  console.error(`serving ${site.pages.length} pages of ${settings.origin} on ${settings.listen}`);
  return server;
}

const started = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? '')).href === import.meta.url; } catch { return false; } })();
if (started) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node do-work/serve.ts <settings.json>');
    process.exit(2);
  }
  start(file).catch(error => {
    console.error(`The site did not start: ${(error as Error).message}`);
    process.exit(1);
  });
}
