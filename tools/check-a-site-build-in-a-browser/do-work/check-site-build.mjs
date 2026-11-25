// tools/check-a-site-build-in-a-browser/do-work/check-site-build.mjs
//
// Purpose
//   The deterministic gate a site deploy calls before it applies a commit: every page kind of a built site is opened in
//   Chromium from the build and from the live site, and the build is refused (exit 1) when a page is blank, throws an
//   error the live page does not, or reads in a serif default where the live page does not. A new unit with no built folder (it draws its pages from rows)
//   is checked as a candidate instead: its side address or unix socket, through serve-candidate.mjs, path by path against live.
//
//   node check-site-build.mjs --candidate <origin or unix:/socket> --live <live origin> [--candidate-app <origin or unix:/socket>
//     --live-app <live app origin>] [--paths </path,https://other-live-host/path>] [--out <folder>]
//   node check-site-build.mjs --pages <built pages folder> --live <live origin> [--app <built app folder> --live-app <live app origin>]
//     --out <folder for pictures> [--server-rendered </prefix,/prefix>] [--settings <file>] [--browser <chromium executable, or BROWSER_EXECUTABLE>]
//   node check-site-build.mjs --request <file>   (what a workflow step runs: the file holds the step's input,
//     {pages | candidate, live, out?, app?, live_app?, server_rendered?, candidate_app?, paths?, commit?}; '' is no value; with commit, each built folder's path
//     must hold that full id, or nothing is checked: exit 2). Without --out / out the pictures go to settings.pictures_folder
//     (under the person's home) /<commit or the time>, so a gate's evidence outlives its run.
//   Prints one JSON line { result: { refused, pages: [...] } } on standard output; progress goes to standard error and ends with
//   the refusal summary (one short line per refused kind, then the count and every refused kind), so the last few hundred
//   characters a workflow keeps of a failed step always name every refusal. Exits 1 when any page is refused, 0 when none is,
//   2 when it could not run at all.
//
// Non-negotiable invariants
//   1. The kinds come from the site's own sitemap and folder (page-kinds.mjs), and for a candidate from its own sitemap plus the
//      paths the caller names (paths its sitemap leaves out, such as a sign-in or a members page).
//   2. Every number and sentence is settings.json; the rules are judge.mjs.
//   2a. A candidate is also refused when its first answer (status; a redirect's target) or the path the browser ends on differs
//       from live's: a signed-out page is held to live's signed-out answer, never signed in.
//   2b. Exactly one of pages and candidate is given, or nothing is checked (exit 2).
//   3. A page that cannot be measured (does not load, no file in the build, live unreadable) is refused, never skipped. The one
//      exception is named by the caller: a kind under a --server-rendered prefix is drawn by the commit's server code, which a
//      built folder cannot show, so its row says checked_here false and why, is not refused, and is counted in not_checked_here.
//   4. The build is only read; nothing is written but the pictures.
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kindOf, pageKinds, sitemapPathsAt } from './page-kinds.mjs';
import { fileFor, serveBuild } from './serve-build.mjs';
import { serveCandidate } from './serve-candidate.mjs';
import { measurePage } from './measure-page.mjs';
import { fill, judge, refusedUnmeasured } from './judge.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const defaultSettings = () => JSON.parse(readFileSync(join(here, '..', 'settings.json'), 'utf8'));

const withCheck = (base, path, settings) => {
  const url = new URL(path, base);
  url.searchParams.set(settings.check_query.name, settings.check_query.value);
  return url.href;
};

/** The status the live address answers a page view, or the problem asking it. */
async function liveStatus(url, timeoutMs) {
  try { return { status: (await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })).status }; } catch (error) { return { error: String(error.cause?.message ?? error.message) }; }
}

async function checkOne({ kind, path, root, live, out, name, settings, browser, localOrigin }) {
  const shots = { local: join(out, `${name}-local.png`), live: join(out, `${name}-live.png`) };
  const url = withCheck(localOrigin, path, settings);
  const liveUrl = withCheck(live, path, settings);
  if (!fileFor(root, new URL(path, 'http://local').pathname)) return refusedUnmeasured({ kind, url, liveUrl, shots: { local: null, live: null }, reason: settings.words.no_file });
  const answered = await liveStatus(liveUrl, settings.navigation_timeout_ms);
  if (answered.error || answered.status !== 404 && answered.status >= 400) return refusedUnmeasured({ kind, url, liveUrl, shots, reason: fill(settings.words.live_unreadable, { error: answered.error ?? `it answered ${answered.status}` }) });
  let built;
  try { built = await measurePage({ url, shot: shots.local, settings, browser }); } catch (error) {
    return refusedUnmeasured({ kind, url, liveUrl, shots, reason: fill(settings.words.did_not_load, { where: 'built', error: error.message }) });
  }
  if (answered.status === 404) return judge({ kind, url, liveUrl: null, built, live: null, shots: { local: shots.local, live: null }, settings });
  let seen;
  try { seen = await measurePage({ url: liveUrl, shot: shots.live, settings, browser }); } catch (error) {
    return refusedUnmeasured({ kind, url, liveUrl, shots, reason: fill(settings.words.did_not_load, { where: 'live', error: error.message }) });
  }
  return judge({ kind, url, liveUrl, built, live: seen, shots, settings });
}

/** The file name a kind's pictures take: "*" is said as "each", so /courses and /courses/* never share a picture. */
export const pictureName = label => label.replace(/\*/g, 'each').replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'home';

const underPrefix = (path, prefixes) => prefixes.some(prefix => path === prefix || path.startsWith(`${prefix.replace(/\/+$/, '')}/`));

/** The row of a kind the caller named as drawn by the commit's server code: neither refused nor passed here. */
const notCheckedHere = ({ kind, url, liveUrl, settings }) => ({ kind, url, live_url: liveUrl, height_px: null, live_height_px: null, height_to_live: null,
  new_page_errors: [], reading_font: null, live_reading_font: null, serif_where_live_is_not: false, visible_text_chars: null, live_visible_text_chars: null,
  screenshots: { local: null, live: null }, refused: false, checked_here: false, why: [settings.words.server_rendered] });

/** Checks every page kind of the built `pages` folder (and `app` folder when given) against the live origins. Answers { refused, not_checked_here, pages }. */
export async function checkSiteBuild({ pages, app = null, live, liveApp = null, out, settings = defaultSettings(), browser = null, serverRendered = [] }) {
  if (app && !liveApp) throw new Error('An app folder needs its live origin (live-app).');
  mkdirSync(out, { recursive: true });
  const places = [{ prefix: '', root: pages, live }, ...(app ? [{ prefix: 'app ', root: app, live: liveApp }] : [])];
  const rows = [];
  for (const place of places) {
    const server = await serveBuild({ root: place.root, live: place.live, settings });
    try {
      for (const { kind, path } of pageKinds(place.root, settings)) {
        const label = `${place.prefix}${kind}`;
        process.stderr.write(`checking ${label}\n`);
        if (underPrefix(path, serverRendered)) {
          rows.push(notCheckedHere({ kind: label, url: withCheck(server.origin, path, settings), liveUrl: withCheck(place.live, path, settings), settings }));
          continue;
        }
        rows.push(await checkOne({ kind: label, path, root: place.root, live: place.live, out, name: pictureName(label), settings, browser, localOrigin: server.origin }));
      }
    } finally {
      await server.close();
    }
  }
  const marked = rows.map(row => ('checked_here' in row ? row : { ...row, checked_here: true }));
  return { refused: marked.filter(row => row.refused).length, not_checked_here: marked.filter(row => !row.checked_here).length, pages: marked };
}

/** The first answer an address gives, redirects not followed: { status, location } with the location as a path on its own
 * origin when it points at `origins`, without the check query; or { error }. */
async function firstAnswer(url, origins, settings) {
  try {
    const answer = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(settings.navigation_timeout_ms) });
    await answer.body?.cancel();
    if (answer.headers.get(settings.candidate_error_header)) return { error: `it could not be reached (${answer.status})` };
    const raw = answer.headers.get('location');
    let location = null;
    if (raw) {
      const where = new URL(raw, url);
      where.searchParams.delete(settings.check_query.name);
      location = origins.includes(where.origin) ? `${where.pathname}${where.search}` : where.href;
    }
    return { status: answer.status, location };
  } catch (error) { return { error: String(error.cause?.message ?? error.message) }; }
}

const said = answer => `${answer.status}${answer.location ? ` to ${answer.location}` : ''}`;
const sameAnswer = (here, there) => (here.status >= 300 && here.status < 400) || (there.status >= 300 && there.status < 400)
  ? here.status === there.status && here.location === there.location
  : Math.floor(here.status / 100) === Math.floor(there.status / 100);

async function checkCandidateOne({ kind, path, door, live, out, name, settings, browser }) {
  const shots = { local: join(out, `${name}-local.png`), live: join(out, `${name}-live.png`) };
  const url = withCheck(door, path, settings);
  const liveUrl = withCheck(live, path, settings);
  const here = await firstAnswer(url, [door, live], settings);
  if (here.error) return refusedUnmeasured({ kind, url, liveUrl, shots: { local: null, live: null }, reason: fill(settings.words.candidate_unreadable, { error: here.error }) });
  const there = await firstAnswer(liveUrl, [door, live], settings);
  if (there.error || there.status !== 404 && there.status >= 400) return refusedUnmeasured({ kind, url, liveUrl, shots, reason: fill(settings.words.live_unreadable, { error: there.error ?? `it answered ${there.status}` }) });
  let built;
  try { built = await measurePage({ url, shot: shots.local, settings, browser }); } catch (error) {
    return refusedUnmeasured({ kind, url, liveUrl, shots, reason: fill(settings.words.did_not_load, { where: 'candidate', error: error.message }) });
  }
  if (there.status === 404) return judge({ kind, url, liveUrl: null, built, live: null, shots: { local: shots.local, live: null }, settings });
  let seen;
  try { seen = await measurePage({ url: liveUrl, shot: shots.live, settings, browser }); } catch (error) {
    return refusedUnmeasured({ kind, url, liveUrl, shots, reason: fill(settings.words.did_not_load, { where: 'live', error: error.message }) });
  }
  const row = judge({ kind, url, liveUrl, built, live: seen, shots, settings });
  const more = [];
  if (!sameAnswer(here, there)) more.push(fill(settings.words.answer_differs, { here: said(here), there: said(there) }));
  if (built.path !== seen.path) more.push(fill(settings.words.landing_differs, { here: built.path, there: seen.path }));
  return more.length ? { ...row, refused: true, why: [...row.why, ...more], also: more } : row;
}

/** A path the caller named, as an address: a path on `live`, or a whole address on another live host (an app's own host). */
const addressOf = (path, live) => new URL(path, live);

/**
 * Checks a candidate (an http(s) origin or "unix:/socket": a new unit with no built folder, placed beside the live one) against
 * the live site: each page kind from `paths` (paths on `live`, or whole addresses on another live host, which go to
 * `candidateApp` when that host is `liveApp`, else to the candidate) and from the candidate's own sitemap, opened through
 * serveCandidate and on the live site. Refused as in folder mode, and also when the first answer (status, redirect target)
 * or the path the browser ends on differs from live. Answers { refused, not_checked_here, pages }.
 */
export async function checkCandidate({ candidate, candidateApp = null, live, liveApp = null, paths = [], out, settings = defaultSettings(), browser = null }) {
  if (candidateApp && !liveApp) throw new Error('A candidate app needs its live origin (live-app).');
  mkdirSync(out, { recursive: true });
  const liveOrigin = new URL(live).origin;
  const appOrigin = liveApp ? new URL(liveApp).origin : null;
  const doors = new Map();
  const doorFor = async origin => {
    if (!doors.has(origin)) doors.set(origin, await serveCandidate({ candidate: candidateApp && origin === appOrigin ? candidateApp : candidate, live: origin, settings }));
    return doors.get(origin).origin;
  };
  const rows = [];
  try {
    const listed = await sitemapPathsAt(await doorFor(liveOrigin), settings);
    const kinds = new Map();
    for (const address of [...paths.map(path => addressOf(path, live)), ...listed.map(path => addressOf(path, live))]) {
      const kind = `${address.origin === liveOrigin ? '' : `${address.host} `}${kindOf(address.pathname)}`;
      if (!kinds.has(kind)) kinds.set(kind, address);
    }
    for (const [kind, address] of kinds) {
      process.stderr.write(`checking ${kind}\n`);
      rows.push({ ...await checkCandidateOne({ kind, path: `${address.pathname}${address.search}`, door: await doorFor(address.origin), live: address.origin, out, name: pictureName(kind), settings, browser }), checked_here: true });
    }
  } finally {
    for (const door of doors.values()) await door.close();
  }
  return { refused: rows.filter(row => row.refused).length, not_checked_here: 0, pages: rows };
}

function argumentsOf(argv) {
  const found = {};
  for (let at = 0; at < argv.length; at += 2) {
    if (!argv[at].startsWith('--') || argv[at + 1] === undefined) throw new Error(`Unreadable argument ${argv[at]}`);
    // An optional value the caller left unfilled ('' or the row's own {name}) is no value.
    if (argv[at + 1] !== '' && !/^\{\w+\}$/.test(argv[at + 1])) found[argv[at].slice(2)] = argv[at + 1];
  }
  return found;
}

/** The command's arguments from a workflow step's request file: the same names as the flags, '' meaning none. */
export function argumentsOfRequest(request) {
  const given = Object.fromEntries(Object.entries(request ?? {}).filter(([, value]) => value !== '' && value !== null && value !== undefined));
  const listOf = value => (Array.isArray(value) ? value.join(',') : value);
  const args = { pages: given.pages, live: given.live, app: given.app, 'live-app': given.live_app, 'server-rendered': listOf(given.server_rendered),
    candidate: given.candidate, 'candidate-app': given.candidate_app, paths: listOf(given.paths), settings: given.settings, browser: given.browser };
  if (given.commit !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(given.commit)) throw new Error(`commit must be a full 40-character commit id, not ${given.commit}`);
    for (const field of ['pages', 'app']) if (args[field] && !args[field].includes(given.commit)) throw new Error(`the ${field} folder ${args[field]} is not named for commit ${given.commit}`);
  }
  args.out = given.out;
  args.commit = given.commit;
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

/** The folder settings.pictures_folder names: $under when it is set, else `else` ('~' is the home folder), then `folder`. */
export const picturesFolder = ({ under, else: otherwise, folder }, env = process.env) => join(env[under] || otherwise.replace(/^~(?=\/|$)/, homedir()), folder);

/** Where the pictures go when the caller names no folder: the pictures folder / the commit or the time. */
export const defaultOut = (settings, commit, env = process.env) => join(picturesFolder(settings.pictures_folder, env), commit ?? new Date().toISOString().replace(/\W/g, ''));

const cut = (text, chars) => (text.length > chars ? `${text.slice(0, chars - 1)}…` : text);

/** The lines that end the command's output: one short line per refused kind, then the count and every refused kind. */
export function refusalSummary(rows, settings) {
  const words = settings.words;
  const refused = rows.filter(row => row.refused);
  const lines = refused.map(row => {
    const parts = [];
    if (row.height_px === null) parts.push(row.why[0]);
    else {
      if (row.live_height_px !== null && row.height_px / row.live_height_px < settings.min_height_to_live) parts.push(fill(words.summary_short, { height_to_live: row.height_to_live }));
      if (row.live_height_px !== null && row.visible_text_chars < 1 && row.live_visible_text_chars >= 1) parts.push(words.summary_blank);
      if (row.new_page_errors.length) parts.push(fill(words.summary_errors, { error: row.new_page_errors[0] }));
      if (row.serif_where_live_is_not) parts.push(fill(words.summary_serif, { font: row.reading_font, live_font: row.live_reading_font ?? 'none' }));
      for (const part of row.fewer_parts ?? []) parts.push(fill(words.summary_parts, { part, count: row.parts[part], live_count: row.live_parts[part] }));
      if (row.live_height_px === null) parts.push(...row.why);
      parts.push(...(row.also ?? []));
    }
    return cut(fill(words.summary_line, { kind: row.kind, reasons: parts.join('; ') }), settings.summary_line_chars);
  });
  return [...lines, fill(words.summary_last, { count: refused.length, kinds: refused.map(row => row.kind).join(', ') || 'none' })];
}

/** Refuses arguments that name neither or both of a built folder (pages) and a candidate address, or a candidate that is not an address. */
export function checkWhatIsChecked(args) {
  if (!args.live) throw new Error('live (the live origin) is needed');
  if (Boolean(args.pages) === Boolean(args.candidate)) throw new Error('give either pages (a built folder) or candidate (a side address or unix:/socket of the new unit), never neither or both');
  if (args.candidate && (args.app || args['server-rendered'])) throw new Error('a candidate is checked whole: app and server-rendered belong to a built folder');
  for (const field of ['candidate', 'candidate-app']) if (args[field] && !/^(https?:\/\/[^/?#]+\/?$|unix:\/)/.test(args[field])) throw new Error(`${field} must be an http(s) origin or unix:/path, not ${args[field]}`);
}

const USAGE = 'usage: node check-site-build.mjs (--pages DIR [--app DIR --live-app ORIGIN] [--server-rendered /PREFIX,/PREFIX] | --candidate ORIGIN|unix:/SOCKET [--candidate-app ORIGIN|unix:/SOCKET --live-app ORIGIN] [--paths /PATH,https://HOST/PATH]) --live ORIGIN [--out DIR] [--settings FILE] [--browser EXECUTABLE] | --request FILE\n';

async function main() {
  const flags = argumentsOf(process.argv.slice(2));
  const args = flags.request ? argumentsOfRequest(JSON.parse(readFileSync(flags.request, 'utf8'))) : flags;
  try { checkWhatIsChecked(args); } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}`);
    process.exit(2);
  }
  const settings = args.settings ? JSON.parse(readFileSync(args.settings, 'utf8')) : defaultSettings();
  const out = args.out ?? defaultOut(settings, args.commit);
  const listed = value => (value ?? '').split(',').map(item => item.trim()).filter(Boolean);
  const result = args.candidate
    ? await checkCandidate({ candidate: args.candidate, candidateApp: args['candidate-app'] ?? null, live: args.live, liveApp: args['live-app'] ?? null, paths: listed(args.paths), out, settings, browser: args.browser ?? null })
    : await checkSiteBuild({ pages: args.pages, app: args.app ?? null, live: args.live, liveApp: args['live-app'] ?? null, out, settings, browser: args.browser ?? null, serverRendered: listed(args['server-rendered']) });
  const report = result.pages.map(row => `${row.refused ? 'REFUSED' : row.checked_here ? 'PASS' : 'NOT CHECKED HERE'} ${row.kind}${row.why.length ? ` -- ${row.why.join('; ')}` : ''}`);
  const summary = [fill(settings.words.pictures_in, { out }), ...refusalSummary(result.pages, settings)];
  // Standard error to a pipe is written asynchronously on macOS: the exit waits for both streams to drain.
  await new Promise(done => process.stderr.write(`${[...report, ...summary].join('\n')}\n`, done));
  process.stdout.write(`${JSON.stringify({ result })}\n`, () => process.exit(result.refused ? 1 : 0));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exit(2); });
}
