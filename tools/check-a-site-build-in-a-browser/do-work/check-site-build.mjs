// tools/check-a-site-build-in-a-browser/do-work/check-site-build.mjs
//
// Purpose
//   The deterministic gate a site deploy calls before it applies a commit: every page kind of a built site is opened in
//   Chromium from the build and from the live site, and the build is refused (exit 1) when a page is blank, throws an
//   error the live page does not, or reads in a serif default where the live page does not.
//
//   node check-site-build.mjs --pages <built pages folder> --live <live origin> [--app <built app folder> --live-app <live app origin>]
//     --out <folder for pictures> [--server-rendered </prefix,/prefix>] [--settings <file>] [--browser <chromium executable, or BROWSER_EXECUTABLE>]
//   node check-site-build.mjs --request <file>   (what a workflow step runs: the file holds the step's input,
//     {pages, live, out?, app?, live_app?, server_rendered?, commit?}; '' is no value; out defaults to a folder under the
//     system temporary folder; with commit, each built folder's path must hold that full id, or nothing is checked: exit 2)
//   Prints one JSON line { result: { refused, pages: [...] } } on standard output (progress goes to standard error); exits 1 when any
//   page is refused, 0 when none is, 2 when it could not run at all.
//
// Non-negotiable invariants
//   1. The kinds come from the site's own sitemap and folder (page-kinds.mjs); there is no hand list.
//   2. Every number and sentence is settings.json; the rules are judge.mjs.
//   3. A page that cannot be measured (does not load, no file in the build, live unreadable) is refused, never skipped. The one
//      exception is named by the caller: a kind under a --server-rendered prefix is drawn by the commit's server code, which a
//      built folder cannot show, so its row says checked_here false and why, is not refused, and is counted in not_checked_here.
//   4. The build is only read; nothing is written but the pictures.
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageKinds } from './page-kinds.mjs';
import { fileFor, serveBuild } from './serve-build.mjs';
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
  new_page_errors: [], reading_font: null, live_reading_font: null, serif_where_live_is_not: false, visible_text_chars: null,
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
  const prefixes = Array.isArray(given.server_rendered) ? given.server_rendered.join(',') : given.server_rendered;
  const args = { pages: given.pages, live: given.live, app: given.app, 'live-app': given.live_app, 'server-rendered': prefixes, settings: given.settings, browser: given.browser };
  if (given.commit !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(given.commit)) throw new Error(`commit must be a full 40-character commit id, not ${given.commit}`);
    for (const field of ['pages', 'app']) if (args[field] && !args[field].includes(given.commit)) throw new Error(`the ${field} folder ${args[field]} is not named for commit ${given.commit}`);
  }
  args.out = given.out ?? join(tmpdir(), 'check-a-site-build', given.commit ?? new Date().toISOString().replace(/\W/g, ''));
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

async function main() {
  const flags = argumentsOf(process.argv.slice(2));
  const args = flags.request ? argumentsOfRequest(JSON.parse(readFileSync(flags.request, 'utf8'))) : flags;
  if (!args.pages || !args.live || !args.out) {
    process.stderr.write('usage: node check-site-build.mjs --pages DIR --live ORIGIN [--app DIR --live-app ORIGIN] --out DIR [--server-rendered /PREFIX,/PREFIX] [--settings FILE] [--browser EXECUTABLE]\n');
    process.exit(2);
  }
  const settings = args.settings ? JSON.parse(readFileSync(args.settings, 'utf8')) : defaultSettings();
  const result = await checkSiteBuild({ pages: args.pages, app: args.app ?? null, live: args.live, liveApp: args['live-app'] ?? null, out: args.out, settings, browser: args.browser ?? null,
    serverRendered: (args['server-rendered'] ?? '').split(',').map(prefix => prefix.trim()).filter(Boolean) });
  for (const row of result.pages) process.stderr.write(`${row.refused ? 'REFUSED' : row.checked_here ? 'PASS' : 'NOT CHECKED HERE'} ${row.kind}${row.why.length ? ` -- ${row.why.join('; ')}` : ''}\n`);
  process.stdout.write(`${JSON.stringify({ result })}\n`, () => process.exit(result.refused ? 1 : 0));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exit(2); });
}
