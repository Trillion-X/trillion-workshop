// tools/check-every-screen-at-every-width/check-given-pages.mjs
//
// The screen check (check-screens.mjs runMatrix) as one run over pages given in the input: each screen's HTML is
// answered by the browser itself at its route on a made-up origin, so nothing is fetched from anywhere. Every screen is
// opened in a headless Chromium (headless-browser/launch.mjs) at every width and in every mode views.json names (or the
// ones asked for), its visible text is read and judged (contrast, font, overflow, horizontal scroll, control names),
// and the failures and the run's report come back. Nothing is kept after the run and no file is written.
//
// Input:
//   screens   [{ id, html, route?, fonts?, ready?, steps?, widths?, modes? }]: the pages. route is the path it is opened
//             at ("/<id>" when left out); fonts are the font families the page itself declares (a glyph drawn by any
//             other platform font fails the font probe; system names such as system-ui never do); ready, steps,
//             widths and modes as in a screens file (README.md)
//   widths    the width ids to read at (views.json: phone, tablet, desktop; all when left out)
//   modes     the mode ids to read in (views.json: light, dark, forced, darkreader; all when left out; the real
//             extension mode needs an unpacked extension and is never run here)
//   allowlist rows that drop a proven false positive or keep a decided look as reported (allowlist.json's shape);
//             none when left out, because the folder's own allowlist is about Trillion's screens
//   pool      how many pages are open at once (views.json pool when left out)
// Answers { passed, failures, reported, counts, report }: counts is failures per probe.
// Refuses a screen without an id or html, two screens at the same route, and a width or mode views.json does not name.
// A request the page makes to any other place is aborted, never sent.
import { launchChromium } from '../headless-browser/launch.mjs';
import { readViews, runMatrix } from './check-screens.mjs';

const ORIGIN = 'http://given-pages.invalid';

export async function checkGivenPages({ screens, widths, modes, allowlist = [], pool } = {}) {
  if (!Array.isArray(screens) || screens.length === 0) throw new Error('Give screens: [{ id, html, route? }], the pages to check.');
  const views = readViews();
  for (const [field, ids, rows] of [['widths', widths, views.widths], ['modes', modes, views.modes.filter(mode => !mode.extension)]]) {
    if (ids === undefined) continue;
    const known = rows.map(row => row.id);
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !known.includes(id))) throw new Error(`${field} is a list of ${known.join(', ')}.`);
  }
  if (!Array.isArray(allowlist)) throw new Error('allowlist is a list of rows in allowlist.json\'s shape.');
  const pages = new Map();
  const rows = screens.map((screen, index) => {
    const { html, ...row } = screen ?? {};
    if (typeof row.id !== 'string' || !row.id) throw new Error(`screens[${index}] needs id: a name for the screen.`);
    if (typeof html !== 'string' || !html) throw new Error(`screens[${index}] (${row.id}) needs html: the page itself.`);
    const route = row.route ?? `/${encodeURIComponent(row.id)}`;
    if (typeof route !== 'string' || !route.startsWith('/')) throw new Error(`screens[${index}] (${row.id}): route is a path starting with /.`);
    const path = new URL(route, ORIGIN).pathname;
    if (pages.has(path)) throw new Error(`screens[${index}] (${row.id}): another screen is at ${path} already; give each its own route.`);
    pages.set(path, html);
    return { ...row, route };
  });

  const browser = await launchChromium({ headless: true });
  const target = {
    origin: ORIGIN,
    newContext: options => browser.newContext(options),
    // The given pages are answered at their routes; every other request is aborted, never sent.
    prepare: context => context.route('**/*', route => {
      const url = new URL(route.request().url());
      const html = url.origin === ORIGIN ? pages.get(url.pathname) : undefined;
      if (html !== undefined) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
      if (url.origin === ORIGIN) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not one of the given pages' });
      return route.abort('blockedbyclient');
    }),
  };
  try {
    const { failures, reported, report } = await runMatrix({ target, screens: { screens: rows }, views, allowlist, only: { widths, modes, pool } });
    const counts = {};
    for (const failure of failures) counts[failure.probe] = (counts[failure.probe] ?? 0) + 1;
    const { failures: _failures, reported: _reported, ...rest } = report;
    return { passed: failures.length === 0, failures, reported, counts, report: rest };
  } finally {
    await browser.close().catch(() => {});
  }
}
