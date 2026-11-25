// tools/check-a-site-build-in-a-browser/do-work/check-site-build.mjs
//
// Purpose
//   The deterministic gate a site deploy calls before it applies a commit: every page kind of a built site is opened in
//   Chromium from the build and from the live site, and the build is refused (exit 1) when a page is blank, throws an
//   error the live page does not, or reads in a serif default where the live page does not.
//
//   node check-site-build.mjs --pages <built pages folder> --live <live origin> [--app <built app folder> --live-app <live app origin>]
//     --out <folder for pictures> [--settings <file>] [--browser <chromium executable, or BROWSER_EXECUTABLE>]
//   Prints one JSON line { result: { refused, pages: [...] } } on standard output (progress goes to standard error); exits 1 when any
//   page is refused, 0 when none is, 2 when it could not run at all.
//
// Non-negotiable invariants
//   1. The kinds come from the site's own sitemap and folder (page-kinds.mjs); there is no hand list.
//   2. Every number and sentence is settings.json; the rules are judge.mjs.
//   3. A page that cannot be measured (does not load, no file in the build, live unreadable) is refused, never skipped.
//   4. The build is only read; nothing is written but the pictures.
import { mkdirSync, readFileSync } from 'node:fs';
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
async function liveStatus(url) {
  try { return { status: (await fetch(url, { redirect: 'follow' })).status }; } catch (error) { return { error: String(error.cause?.message ?? error.message) }; }
}

async function checkOne({ kind, path, root, live, out, name, settings, browser, localOrigin }) {
  const shots = { local: join(out, `${name}-local.png`), live: join(out, `${name}-live.png`) };
  const url = withCheck(localOrigin, path, settings);
  const liveUrl = withCheck(live, path, settings);
  if (!fileFor(root, new URL(path, 'http://local').pathname)) return refusedUnmeasured({ kind, url, liveUrl, shots: { local: null, live: null }, reason: settings.words.no_file });
  const answered = await liveStatus(liveUrl);
  if (answered.error) return refusedUnmeasured({ kind, url, liveUrl, shots, reason: fill(settings.words.live_unreadable, { error: answered.error }) });
  let built;
  try { built = await measurePage({ url, shot: shots.local, settings, browser }); } catch (error) {
    return refusedUnmeasured({ kind, url, liveUrl, shots, reason: fill(settings.words.did_not_load, { where: 'built', error: error.message }) });
  }
  if (answered.status >= 400) return judge({ kind, url, liveUrl: null, built, live: null, shots: { local: shots.local, live: null }, settings });
  let seen;
  try { seen = await measurePage({ url: liveUrl, shot: shots.live, settings, browser }); } catch (error) {
    return refusedUnmeasured({ kind, url, liveUrl, shots, reason: fill(settings.words.did_not_load, { where: 'live', error: error.message }) });
  }
  return judge({ kind, url, liveUrl, built, live: seen, shots, settings });
}

/** Checks every page kind of the built `pages` folder (and `app` folder when given) against the live origins. Answers { refused, pages }. */
export async function checkSiteBuild({ pages, app = null, live, liveApp = null, out, settings = defaultSettings(), browser = null }) {
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
        rows.push(await checkOne({ kind: label, path, root: place.root, live: place.live, out, name: label.replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'home', settings, browser, localOrigin: server.origin }));
      }
    } finally {
      await server.close();
    }
  }
  return { refused: rows.filter(row => row.refused).length, pages: rows };
}

function argumentsOf(argv) {
  const found = {};
  for (let at = 0; at < argv.length; at += 2) {
    if (!argv[at].startsWith('--') || argv[at + 1] === undefined) throw new Error(`Unreadable argument ${argv[at]}`);
    found[argv[at].slice(2)] = argv[at + 1];
  }
  return found;
}

async function main() {
  const args = argumentsOf(process.argv.slice(2));
  if (!args.pages || !args.live || !args.out) {
    process.stderr.write('usage: node check-site-build.mjs --pages DIR --live ORIGIN [--app DIR --live-app ORIGIN] --out DIR [--settings FILE] [--browser EXECUTABLE]\n');
    process.exit(2);
  }
  const settings = args.settings ? JSON.parse(readFileSync(args.settings, 'utf8')) : defaultSettings();
  const result = await checkSiteBuild({ pages: args.pages, app: args.app ?? null, live: args.live, liveApp: args['live-app'] ?? null, out: args.out, settings, browser: args.browser ?? null });
  for (const row of result.pages) process.stderr.write(`${row.refused ? 'REFUSED' : 'PASS'} ${row.kind}${row.why.length ? ` -- ${row.why.join('; ')}` : ''}\n`);
  process.stdout.write(`${JSON.stringify({ result })}\n`, () => process.exit(result.refused ? 1 : 0));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exit(2); });
}
