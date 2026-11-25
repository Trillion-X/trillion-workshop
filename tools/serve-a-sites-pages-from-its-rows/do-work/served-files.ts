// tools/serve-a-sites-pages-from-its-rows/do-work/served-files.ts
//
// PURPOSE
//   Files a site answers itself, from its files store, with 200 at its own address: a web app's shell page, its module
//   scripts, its WebAssembly engines and its fonts. A browser loads those only from the page's own origin (a module script, a
//   font and a fetched engine are CORS requests, and the store sends no CORS headers), so a 302 to a presigned link, as
//   public_files answers, breaks them. Each rule (settings `served_files`) names the paths it answers, on which hosts, and the
//   store keys they are:
//     { "hosts": ["app.example.com"], "paths": ["/workspace/", "/app.js"], "named": { "/": "index.html" },
//       "key_prefix": "site-app-files/", "cache_seconds": 300 }
//   A path in `paths` (a folder ending in "/" or one whole path) is the key key_prefix + the path without its leading slash; a
//   path in `named` is key_prefix + the name given (a host's "/" is its index.html). The first rule that names a path answers it.
//   With "rest": "not_found" a rule's hosts answer nothing else: every other path on them is 404, ahead of pass_on and the
//   page rows (a retired name that keeps only its moved-to page).
//
//   With "only_listed_by": { "tool", "input", "seconds" } a rule answers a path only while the latest answer of that listing tool
//   names it: the program runs the tool as the site (its own key, the input as written), keeps the answer for `seconds`, and takes
//   every text in it that is a site path ("/..." up to any "?" or "#") as the listed paths. Every other path the rule names is 404.
//   It is for files whose showing someone may withdraw (a published clip whose person took back consent): the listing tool holds
//   them to its rules at each read, so a withdrawn file stops answering within `seconds`, and a browser keeps one no longer than
//   that (its max-age is the smaller of cache_seconds and seconds). A listing that fails is never stood in for by an older one:
//   the paths answer 503 until the tool answers again.
//     { "hosts": ["example.com"], "paths": ["/published-clips/"], "key_prefix": "site-files/", "cache_seconds": 86400,
//       "only_listed_by": { "tool": "tool:read-the-clips-published-to-a-site", "input": { "database": "a_site", "limit": 100 }, "seconds": 60 } }
//
//   The program reads each object with a presigned GET of its own (member-video.ts presignedGet, the store's read key) and keeps
//   it in memory, at most MOST_KEPT_BYTES in all, the least recently asked dropped first; after cache_seconds it asks the store
//   again with the object's ETag, so a replaced object is served within cache_seconds and an unchanged one is not sent again.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only keys a rule names are read, with no empty, "." or ".." part.
//   2. A key the store does not hold answers 404; a store that does not answer answers 502, and a kept copy is never served
//      past twice its cache_seconds when the store cannot be asked.
//   3. The answer's type comes from the file's name (TYPES below), never from the store, so a page is text/html and an engine
//      application/wasm wherever the object was put.
//   4. One "bytes=a-b" range is answered 206 from the kept bytes; any other range is the whole file (200).
//   5. The read key only signs: it is never in an answer, a header or a log.
//   6. A rule with only_listed_by answers a path only when a listing no older than its seconds names it; one listing is asked
//      at a time per tool and input, and a failed listing answers 503, never an older list.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { presignedGet } from './member-video.ts';
import type { FilesStore, StoreKey } from './member-video.ts';
import type { Answer } from './screen-files.ts';
import type { ToolRun } from './door.ts';

/** The tool whose answer lists the paths a rule may answer, its input as written, and how long one answer is used. */
export interface ListedBy {
  tool: string;
  input: Record<string, unknown>;
  seconds: number;
}

export interface ServedFiles {
  hosts?: string[];
  paths: string[];
  named?: Record<string, string>;
  key_prefix: string;
  cache_seconds: number;
  /** "not_found": the rule's hosts answer only what it names; every other path on them is 404. */
  rest?: 'not_found';
  /** Answer a path only while this listing tool's latest answer names it; every other path the rule names is 404. */
  only_listed_by?: ListedBy;
}

/** The most bytes kept in memory across every rule. */
export const MOST_KEPT_BYTES = 128 * 1024 * 1024;
const LINK_SECONDS = 300;

export const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json', map: 'application/json', wasm: 'application/wasm', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', ico: 'image/x-icon', woff2: 'font/woff2', woff: 'font/woff',
  ttf: 'font/ttf', otf: 'font/otf', txt: 'text/plain; charset=utf-8', xml: 'application/xml', pdf: 'application/pdf', mp4: 'video/mp4',
  webm: 'video/webm', mp3: 'audio/mpeg', bcmap: 'application/octet-stream', data: 'application/octet-stream', md: 'text/markdown; charset=utf-8',
};

const PATH = /^\/([A-Za-z0-9._~@+-]+\/)*[A-Za-z0-9._~@+-]*$/;
const KEY = /^[A-Za-z0-9._~@+-]+(\/[A-Za-z0-9._~@+-]+)*$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const WORDS = 'served_files lists { hosts?, paths, named?, key_prefix, cache_seconds, rest? }: lower-case host names; site folders ending in "/" or whole paths; { "<site path>": "<key name>" }; "" or key folders ending in "/"; a whole number of seconds, 1 to 86400; rest "not_found" only with hosts; only_listed_by { tool: "tool:<id>", input: { ... }, seconds: 1 to 3600 }.';

/** Checks the settings' served_files; a wrong one throws naming what each field should be. */
export function servedFilesOf(value: unknown): ServedFiles[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(WORDS);
  for (const rule of value as Partial<ServedFiles>[]) {
    const named = rule?.named ?? {};
    if (!rule || typeof rule !== 'object' || !Array.isArray(rule.paths) || rule.paths.some(path => typeof path !== 'string' || !PATH.test(path) || path === '/')
      || (rule.hosts !== undefined && (!Array.isArray(rule.hosts) || rule.hosts.some(host => typeof host !== 'string' || !HOST.test(host))))
      || !named || typeof named !== 'object' || Array.isArray(named) || Object.entries(named).some(([path, key]) => !PATH.test(path) || typeof key !== 'string' || !KEY.test(key) || key.split('/').some(part => part === '.' || part === '..'))
      || (rule.paths.length === 0 && Object.keys(named).length === 0)
      || typeof rule.key_prefix !== 'string' || !/^([A-Za-z0-9._-]+\/)*$/.test(rule.key_prefix)
      || !Number.isInteger(rule.cache_seconds) || rule.cache_seconds! < 1 || rule.cache_seconds! > 86400
      || (rule.rest !== undefined && (rule.rest !== 'not_found' || !rule.hosts?.length))
      || (rule.only_listed_by !== undefined && !listedByIsGood(rule.only_listed_by))) throw new Error(WORDS);
  }
  return value as ServedFiles[];
}

function listedByIsGood(by: unknown): boolean {
  const given = by as Partial<ListedBy> | null;
  return Boolean(given) && typeof given === 'object' && !Array.isArray(given) && Object.keys(given!).every(key => ['tool', 'input', 'seconds'].includes(key))
    && typeof given!.tool === 'string' && /^tool:[a-z0-9]+(-[a-z0-9]+)*$/.test(given!.tool)
    && Boolean(given!.input) && typeof given!.input === 'object' && !Array.isArray(given!.input)
    && Number.isInteger(given!.seconds) && given!.seconds! >= 1 && given!.seconds! <= 3600;
}

/** The rule and store key a host's path is, or null when no rule names it. */
export function servedKeyOf(rules: ServedFiles[], host: string, pathname: string): { rule: ServedFiles; key: string } | null {
  for (const rule of rules) {
    if (rule.hosts?.length && !rule.hosts.includes(host)) continue;
    const name = rule.named && Object.hasOwn(rule.named, pathname) ? rule.named[pathname]
      : rule.paths.some(path => (path.endsWith('/') ? pathname.startsWith(path) && pathname.length > path.length : pathname === path)) ? pathname.slice(1) : null;
    if (name === null) continue;
    let key: string;
    try { key = decodeURIComponent(name); } catch { return null; }
    if (!KEY.test(key) || key.split('/').some(part => part === '.' || part === '..')) return null;
    return { rule, key: `${rule.key_prefix}${key}` };
  }
  return null;
}

/** True when a host's path is closed: a rule with rest "not_found" holds the host, and no rule names the path. */
export function closedOnHost(rules: ServedFiles[], host: string, pathname: string): boolean {
  return rules.some(rule => rule.rest === 'not_found' && rule.hosts!.includes(host)) && servedKeyOf(rules, host, pathname) === null;
}

interface Kept {
  bytes: Buffer;
  etag: string | null;
  checkedAt: number;
}

/** Reads served files from the store and keeps them, bounded, revalidated after cache_seconds. */
export class StoreFiles {
  #kept = new Map<string, Kept>();
  #bytes = 0;
  #asking = new Map<string, Promise<Kept | null>>();
  readonly #store: FilesStore;
  readonly #key: StoreKey;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(store: FilesStore, key: StoreKey, { fetchImpl = fetch, now = Date.now }: { fetchImpl?: typeof fetch; now?: () => number } = {}) {
    this.#store = store;
    this.#key = key;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  /** The answer for one served file: 200 (or 206 for one range), 404 when the store holds no such key, 502 when it fails. */
  async answer(rule: ServedFiles, key: string, range: string | undefined): Promise<Answer> {
    const name = key.slice(key.lastIndexOf('/') + 1);
    const type = TYPES[name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''] ?? 'application/octet-stream';
    let kept: Kept | null;
    try {
      kept = await this.#read(rule, key);
    } catch (error) {
      console.error(`served file ${key}: ${(error as Error).message}`);
      return { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: 'This file could not be read. Try again in a minute.\n' };
    }
    if (!kept) return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: 'No such file.\n' };
    const maxAge = rule.only_listed_by ? Math.min(rule.cache_seconds, rule.only_listed_by.seconds) : rule.cache_seconds;
    const headers: Record<string, string> = { 'content-type': type, 'cache-control': `public, max-age=${maxAge}`, 'accept-ranges': 'bytes', ...(kept.etag ? { etag: kept.etag } : {}) };
    const asked = /^bytes=(\d*)-(\d*)$/.exec(range ?? '');
    if (asked && (asked[1] !== '' || asked[2] !== '')) {
      const size = kept.bytes.length;
      const start = asked[1] === '' ? Math.max(0, size - Number(asked[2])) : Number(asked[1]);
      const end = asked[1] === '' || asked[2] === '' ? size - 1 : Math.min(Number(asked[2]), size - 1);
      if (start > end || start >= size) return { status: 416, headers: { 'content-range': `bytes */${size}`, 'cache-control': 'no-store' }, body: '' };
      return { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}` }, body: kept.bytes.subarray(start, end + 1) };
    }
    return { status: 200, headers, body: kept.bytes };
  }

  /** The kept copy, asked of the store again when it is older than cache_seconds; one store read at a time per key. */
  async #read(rule: ServedFiles, key: string): Promise<Kept | null> {
    const kept = this.#kept.get(key);
    const now = this.#now();
    if (kept && now - kept.checkedAt < rule.cache_seconds * 1000) return this.#touch(key, kept);
    if (!this.#asking.has(key)) {
      this.#asking.set(key, this.#ask(key, kept ?? null).finally(() => this.#asking.delete(key)));
    }
    try {
      return await this.#asking.get(key)!;
    } catch (error) {
      if (kept && now - kept.checkedAt < rule.cache_seconds * 2000) return kept;
      throw error;
    }
  }

  async #ask(key: string, kept: Kept | null): Promise<Kept | null> {
    const link = presignedGet(this.#store, this.#key, key, LINK_SECONDS, new Date(this.#now()));
    const answer = await this.#fetch(link, { headers: kept?.etag ? { 'if-none-match': kept.etag } : {}, signal: AbortSignal.timeout(30_000) });
    if (answer.status === 304 && kept) return this.#keep(key, { ...kept, checkedAt: this.#now() });
    if (answer.status === 404 || answer.status === 403) {
      await answer.arrayBuffer().catch(() => undefined);
      this.#drop(key);
      return null;
    }
    if (!answer.ok) throw new Error(`the store answered ${answer.status}`);
    return this.#keep(key, { bytes: Buffer.from(await answer.arrayBuffer()), etag: answer.headers.get('etag'), checkedAt: this.#now() });
  }

  #keep(key: string, kept: Kept): Kept {
    this.#drop(key);
    if (kept.bytes.length > MOST_KEPT_BYTES) return kept;
    this.#kept.set(key, kept);
    this.#bytes += kept.bytes.length;
    for (const [oldest, copy] of this.#kept) {
      if (this.#bytes <= MOST_KEPT_BYTES) break;
      this.#kept.delete(oldest);
      this.#bytes -= copy.bytes.length;
    }
    return kept;
  }

  #touch(key: string, kept: Kept): Kept {
    this.#kept.delete(key);
    this.#kept.set(key, kept);
    return kept;
  }

  #drop(key: string): void {
    const old = this.#kept.get(key);
    if (!old) return;
    this.#kept.delete(key);
    this.#bytes -= old.bytes.length;
  }
}

/** Every site path ("/...", up to any "?" or "#") a listing tool's answer holds, anywhere in it. */
export function listedPathsOf(answer: unknown): Set<string> {
  const paths = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      const path = value.split(/[?#]/, 1)[0];
      if (path.startsWith('/') && !path.startsWith('//')) paths.add(path);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(answer);
  return paths;
}

/** 404 for a path no listing names, 503 while the listing cannot be read: both never kept by a browser. */
export const NOT_LISTED: Answer = { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: 'No such file.\n' };
export const LISTING_UNREAD: Answer = { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '60' }, body: 'This file cannot be shown right now. Try again in a minute.\n' };

/** The paths each only_listed_by tool names, asked of the tool again after its seconds; one ask at a time per tool and input. */
export class ListedPaths {
  #lists = new Map<string, { paths: Set<string>; at: number }>();
  #asking = new Map<string, Promise<Set<string>>>();
  readonly #run: (call: ToolRun) => Promise<unknown>;
  readonly #now: () => number;

  constructor(run: (call: ToolRun) => Promise<unknown>, { now = Date.now }: { now?: () => number } = {}) {
    this.#run = run;
    this.#now = now;
  }

  /** True when the listing's latest answer, no older than its seconds, names the path; throws when the listing cannot be read. */
  async names(by: ListedBy, pathname: string): Promise<boolean> {
    const key = JSON.stringify([by.tool, by.input]);
    const kept = this.#lists.get(key);
    if (kept && this.#now() - kept.at < by.seconds * 1000) return kept.paths.has(pathname);
    if (!this.#asking.has(key)) {
      this.#asking.set(key, this.#run({ tool: by.tool, input: by.input })
        .then(answer => {
          const paths = listedPathsOf(answer);
          this.#lists.set(key, { paths, at: this.#now() });
          return paths;
        }, error => {
          this.#lists.delete(key);
          throw error;
        })
        .finally(() => this.#asking.delete(key)));
    }
    return (await this.#asking.get(key)!).has(pathname);
  }
}
