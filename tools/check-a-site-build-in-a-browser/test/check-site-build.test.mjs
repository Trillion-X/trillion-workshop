// tools/check-a-site-build-in-a-browser: every page kind of a built site is opened in Chromium beside the live site and the
// build is refused when a page is blank, throws an error the live page does not, or reads in a serif default where the live
// page does not. The "live" site is a second local server over made-up folders, so no test touches the network.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { chromiumExecutable } from '../../../test-helpers/chromium.mjs';
import { argumentsOfRequest, checkSiteBuild, defaultOut, defaultSettings, pictureName, refusalSummary } from '../do-work/check-site-build.mjs';
import { pageKinds } from '../do-work/page-kinds.mjs';
import { serveBuild } from '../do-work/serve-build.mjs';

const settings = { ...defaultSettings(), settle_ms: 600, navigation_timeout_ms: 20000 };
const browser = chromiumExecutable();

const page = ({ script = '', body = '' }) => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body><div id="root">${body}</div><script>${script}</script></body></html>`;
const SANS = 'font-family: Arial, Helvetica, sans-serif';
const TIMES = 'font-family: "Times New Roman", serif';
const tall = (px, font = SANS) => page({ body: `<div style="height:${px}px"><p style="${font}">The reading text of the page.</p></div>` });
const throwsToUpper = page({ body: '<div style="height:63px"></div>', script: 'const course = {}; course.name.toUpperCase();' });
const sitemap = paths => `<?xml version="1.0"?><urlset>${paths.map(path => `<url><loc>https://live.example${path}</loc></url>`).join('')}</urlset>`;

function folder(files) {
  const root = mkdtempSync(join(tmpdir(), 'site-build-test-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

const liveFiles = { 'index.html': tall(3490), 'courses/yoga.html': tall(3490), 'about.html': tall(1200) };
async function run(builtFiles, more = {}) {
  const live = await serveBuild({ root: folder(liveFiles), settings });
  try {
    return await checkSiteBuild({ pages: folder(builtFiles), live: live.origin, out: mkdtempSync(join(tmpdir(), 'site-build-out-')), settings, browser, ...more });
  } finally {
    await live.close();
  }
}
const byKind = (result, kind) => result.pages.find(row => row.kind === kind);

test('page kinds come from the sitemap grouped by path shape plus the top-level pages it leaves out', () => {
  const root = folder({ 'sitemap.xml': sitemap(['/', '/courses/yoga', '/courses/tennis', '/blog/2026/a', '/blog/2026/b', '/pricing']), 'index.html': 'x', 'extra.html': 'x', 'pricing.html': 'x' });
  assert.deepEqual(pageKinds(root, settings), [
    { kind: '/', path: '/' }, { kind: '/courses/*', path: '/courses/yoga' }, { kind: '/blog/2026/*', path: '/blog/2026/a' },
    { kind: '/pricing', path: '/pricing' }, { kind: '/extra', path: '/extra' },
  ]);
});

test('a blank course page that throws TypeError (toUpperCase) against a tall live page is refused for height and for the new error', async () => {
  const result = await run({ 'sitemap.xml': sitemap(['/courses/yoga']), 'courses/yoga.html': throwsToUpper });
  const row = byKind(result, '/courses/*');
  assert.equal(row.refused, true);
  assert.ok(row.height_px <= settings.viewport.height, `built height ${row.height_px}: a blank page is only as tall as the window`);
  assert.ok(row.live_height_px > 3000, `live height ${row.live_height_px}`);
  assert.ok(row.height_to_live < 0.5);
  assert.equal(row.new_page_errors.length, 1);
  assert.match(row.new_page_errors[0], /Cannot read properties of undefined \(reading 'toUpperCase'\)/);
  assert.equal(row.why.length, 2);
  assert.equal(result.refused, 1);
});

test('a serif home against a sans live home is refused for its reading font alone', async () => {
  const result = await run({ 'sitemap.xml': sitemap(['/']), 'index.html': tall(3490, TIMES) });
  const row = byKind(result, '/');
  assert.equal(row.refused, true);
  assert.equal(row.serif_where_live_is_not, true);
  assert.match(row.reading_font, /Times/);
  assert.match(row.live_reading_font, /Arial/);
  assert.equal(row.why.length, 1);
  assert.deepEqual(row.new_page_errors, []);
});

test('a page that matches the live page passes, and so does a serif page where the live page is serif too', async () => {
  const result = await run({ 'sitemap.xml': sitemap(['/', '/courses/yoga']), 'index.html': tall(3490), 'courses/yoga.html': tall(3300) });
  assert.equal(result.refused, 0);
  assert.equal(byKind(result, '/').height_to_live, 1);
  assert.ok(byKind(result, '/courses/*').height_to_live > 0.9);
  assert.ok(result.pages.every(row => row.screenshots.local && readFileSync(row.screenshots.local).length > 100));
  const serifLive = await serveBuild({ root: folder({ 'index.html': tall(3490, TIMES) }), settings });
  try {
    const same = await checkSiteBuild({ pages: folder({ 'sitemap.xml': sitemap(['/']), 'index.html': tall(3490, TIMES) }), live: serifLive.origin, out: mkdtempSync(join(tmpdir(), 'site-build-out-')), settings, browser });
    assert.equal(same.refused, 0, JSON.stringify(same.pages[0].why));
  } finally {
    await serifLive.close();
  }
});

test('a page kind with no live page passes with text and no error, and is refused with an error or no text', async () => {
  const drawn = page({ body: '<p>An event that exists only in the build.</p>' });
  const passes = await run({ 'sitemap.xml': sitemap(['/events/summer']), 'events/summer.html': drawn });
  assert.equal(byKind(passes, '/events/*').refused, false);
  assert.equal(byKind(passes, '/events/*').live_height_px, null);
  const errors = await run({ 'sitemap.xml': sitemap(['/events/summer']), 'events/summer.html': page({ body: '<p>text</p>', script: 'null.x' }) });
  assert.equal(byKind(errors, '/events/*').refused, true);
  assert.match(byKind(errors, '/events/*').why[0], /no live page exists and the built page threw/);
  const blank = await run({ 'sitemap.xml': sitemap(['/events/summer']), 'events/summer.html': page({}) });
  assert.match(byKind(blank, '/events/*').why[0], /shows no text/);
});

test('each kind keeps its own pictures: /courses and /courses/* never share a file name', () => {
  assert.equal(pictureName('/courses'), 'courses');
  assert.equal(pictureName('/courses/*'), 'courses-each');
  assert.equal(pictureName('/'), 'home');
  assert.equal(pictureName('app /'), 'app');
  assert.equal(pictureName('app /courses/*'), 'app-courses-each');
});

test('a request file gives the same arguments as the flags; empty values are none; a folder not named for the commit is refused', () => {
  const commit = 'b6ff62aeeb61ea3628240821e57b5c5a8b6e1063';
  const args = argumentsOfRequest({ commit, pages: `/built/site-${commit}/public`, live: 'https://live.example', app: '', live_app: '', server_rendered: '/articles,/feeds' });
  assert.deepEqual(args, { pages: `/built/site-${commit}/public`, live: 'https://live.example', 'server-rendered': '/articles,/feeds', commit });
  assert.equal(defaultOut({ pictures_folder: { under: 'KEPT_HOME', else: '~/kept', folder: 'checks' } }, commit, {}), join(homedir(), 'kept', 'checks', commit));
  assert.equal(defaultOut(settings, commit, {}), join(homedir(), '.local', 'share', 'site-build-checks', commit));
  assert.equal(defaultOut(settings, commit, { XDG_DATA_HOME: '/data/home' }), join('/data/home', 'site-build-checks', commit));
  assert.equal(argumentsOfRequest({ pages: 'p', live: 'l', server_rendered: ['/a', '/b'] })['server-rendered'], '/a,/b');
  assert.throws(() => argumentsOfRequest({ commit, pages: '/built/site-f6a44b6247f96fba32676213783905459d3dabb4/public', live: 'l' }), /not named for commit/);
  assert.throws(() => argumentsOfRequest({ commit, pages: `/built/site-${commit}/public`, app: '/built/older/app', live: 'l', live_app: 'l' }), /app folder/);
  assert.throws(() => argumentsOfRequest({ commit: 'b6ff62aee', pages: 'b6ff62aee', live: 'l' }), /full 40-character/);
});

test('three refused kinds are each named in the last 600 characters a workflow keeps of the failed command', async () => {
  const live = await serveBuild({ root: folder(liveFiles), settings });
  try {
    const built = folder({ 'sitemap.xml': sitemap(['/', '/courses/yoga', '/about']), 'index.html': tall(3490, TIMES), 'courses/yoga.html': throwsToUpper });
    const ran = await promisify(execFile)(process.execPath, [new URL('../do-work/check-site-build.mjs', import.meta.url).pathname,
      '--pages', built, '--live', live.origin, '--out', mkdtempSync(join(tmpdir(), 'site-build-out-'))], { env: { ...process.env, BROWSER_EXECUTABLE: browser } }).then(done => ({ code: 0, ...done }), failed => failed);
    assert.equal(ran.code, 1);
    // The workflow host keeps the last 600 characters of standard output followed by standard error.
    const tail = `${ran.stdout}${ran.stderr}`.slice(-600);
    assert.match(tail, /REFUSED \/: serif [^\n]*Times[^\n]* where live is Arial/);
    assert.match(tail, /REFUSED \/courses\/\*: 0\.\d+ of the live height; new page error TypeError/);
    assert.match(tail, /REFUSED \/about: the build holds no file for this path/);
    assert.match(tail, /3 page kind\(s\) refused: \/, \/courses\/\*, \/about\n$/);
  } finally {
    await live.close();
  }
});

test('the refusal summary keeps each line short and ends with the count, also when nothing is refused', () => {
  const row = (kind, more) => ({ kind, refused: true, height_px: 900, live_height_px: 3000, height_to_live: 0.3, new_page_errors: ['TypeError: ' + 'x'.repeat(400)], serif_where_live_is_not: false, reading_font: null, live_reading_font: null, why: [], ...more });
  const lines = refusalSummary([row('/a'), row('/b'), row('/c'), { kind: '/d', refused: false }], settings);
  assert.equal(lines.length, 4);
  for (const line of lines.slice(0, 3)) assert.ok(line.length <= settings.summary_line_chars, line);
  assert.equal(lines[3], '3 page kind(s) refused: /a, /b, /c');
  assert.deepEqual(refusalSummary([], settings), ['0 page kind(s) refused: none']);
});

test('a sitemap path with no file in the build is refused, never skipped', async () => {
  const result = await run({ 'sitemap.xml': sitemap(['/courses/yoga']) });
  assert.equal(byKind(result, '/courses/*').refused, true);
  assert.equal(byKind(result, '/courses/*').why[0], settings.words.no_file);
});

test('a kind under a named server-rendered prefix is not checked here and not refused; a prefix matches whole segments only', async () => {
  const built = { 'sitemap.xml': sitemap(['/about', '/articles', '/articles/first', '/articlesx']), 'about.html': tall(1200) };
  const result = await run(built, { serverRendered: ['/articles'] });
  assert.equal(byKind(result, '/articles').checked_here, false);
  assert.equal(byKind(result, '/articles/*').checked_here, false);
  assert.equal(byKind(result, '/articles/*').refused, false);
  assert.equal(byKind(result, '/articles/*').why[0], settings.words.server_rendered);
  assert.equal(byKind(result, '/about').checked_here, true);
  assert.equal(byKind(result, '/articlesx').refused, true);
  assert.equal(result.not_checked_here, 2);
  assert.equal(result.refused, 1);
  const unnamed = await run(built);
  assert.equal(byKind(unnamed, '/articles').refused, true);
  assert.equal(unnamed.not_checked_here, 0);
});

test('the height rule compares the exact ratio: 4,998 of 10,000 px is refused although it rounds to 0.5', async () => {
  const { judge } = await import('../do-work/judge.mjs');
  const measured = height => ({ height, font: 'Arial', text: 5, errors: [] });
  const row = height => judge({ kind: '/', url: 'a', liveUrl: 'b', built: measured(height), live: measured(10000), shots: {}, settings });
  assert.equal(row(4998).refused, true);
  assert.equal(row(5000).refused, false);
});

test('a live page that answers 500 refuses the page as unreadable instead of switching to the absolute check', async () => {
  const http = await import('node:http');
  const broken = http.createServer((_, res) => { res.writeHead(500); res.end('x'); });
  await new Promise(done => broken.listen(0, '127.0.0.1', done));
  try {
    const result = await checkSiteBuild({ pages: folder({ 'sitemap.xml': sitemap(['/about']), 'about.html': tall(1200) }), live: `http://127.0.0.1:${broken.address().port}`, out: mkdtempSync(join(tmpdir(), 'site-build-out-')), settings, browser });
    assert.equal(result.pages[0].refused, true);
    assert.match(result.pages[0].why[0], /answered 500/);
  } finally {
    broken.closeAllConnections();
    await new Promise(done => broken.close(done));
  }
});

test('the command prints one JSON line and exits 1 when a page is refused, 0 when none is', async () => {
  const live = await serveBuild({ root: folder(liveFiles), settings });
  const command = (built, out) => promisify(execFile)(process.execPath, [new URL('../do-work/check-site-build.mjs', import.meta.url).pathname,
    '--pages', built, '--live', live.origin, '--out', out], { env: { ...process.env, BROWSER_EXECUTABLE: browser } }).then(done => ({ code: 0, ...done }), failed => failed);
  try {
    const refused = await command(folder({ 'sitemap.xml': sitemap(['/courses/yoga']), 'courses/yoga.html': throwsToUpper }), mkdtempSync(join(tmpdir(), 'site-build-out-')));
    assert.equal(refused.code, 1);
    const line = JSON.parse(refused.stdout.trim());
    assert.equal(line.result.refused, 1);
    assert.equal(refused.stdout.trim().split('\n').length, 1);
    const passed = await command(folder({ 'sitemap.xml': sitemap(['/about']), 'about.html': tall(1200) }), mkdtempSync(join(tmpdir(), 'site-build-out-')));
    assert.equal(passed.code, 0, passed.stderr);
    const request = join(mkdtempSync(join(tmpdir(), 'site-build-request-')), 'step.request.json');
    writeFileSync(request, JSON.stringify({ pages: folder({ 'sitemap.xml': sitemap(['/courses/yoga']), 'courses/yoga.html': throwsToUpper }), live: live.origin, out: mkdtempSync(join(tmpdir(), 'site-build-out-')), app: '', live_app: '', server_rendered: '' }));
    const byRequest = await promisify(execFile)(process.execPath, [new URL('../do-work/check-site-build.mjs', import.meta.url).pathname, '--request', request],
      { env: { ...process.env, BROWSER_EXECUTABLE: browser } }).then(done => ({ code: 0, ...done }), failed => failed);
    assert.equal(byRequest.code, 1);
    assert.equal(JSON.parse(byRequest.stdout.trim()).result.refused, 1);
    writeFileSync(request, JSON.stringify({ commit: 'b6ff62aeeb61ea3628240821e57b5c5a8b6e1063', pages: '/somewhere/else', live: live.origin }));
    const wrongFolder = await promisify(execFile)(process.execPath, [new URL('../do-work/check-site-build.mjs', import.meta.url).pathname, '--request', request]).then(done => ({ code: 0, ...done }), failed => failed);
    assert.equal(wrongFolder.code, 2);
    assert.match(wrongFolder.stderr, /not named for commit/);
  } finally {
    await live.close();
  }
});

test('data calls pass to the live site with no query added, Referer and Origin naming the live host; page views carry the check query', async () => {
  const seen = [];
  const http = await import('node:http');
  const stand = http.createServer((req, res) => { seen.push({ url: req.url, referer: req.headers.referer, origin: req.headers.origin }); res.end('ok'); });
  await new Promise(done => stand.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${stand.address().port}`;
  const local = await serveBuild({ root: folder({ 'index.html': 'x' }), live: origin, settings });
  try {
    await fetch(`${local.origin}/target/offers-for-this-page`, { headers: { referer: `${local.origin}/courses/yoga?utm_content=check`, origin: local.origin } });
    await fetch(`${local.origin}/media/clip.mp4`);
    assert.deepEqual(seen[0], { url: '/target/offers-for-this-page', referer: `${origin}/courses/yoga?utm_content=check`, origin });
    assert.equal(seen[1].url, '/media/clip.mp4?utm_content=check');
  } finally {
    await local.close();
    stand.closeAllConnections();
    await new Promise(done => stand.close(done));
  }
});

// Candidate mode: a new unit with no built folder, checked at its side address (or unix socket) against live.
const { checkCandidate, checkWhatIsChecked } = await import('../do-work/check-site-build.mjs');

/** A stand-in site: path -> { status, location, body }; on a free loopback port, or on a unix socket when `socket` is given. */
async function stand(routes, socket = null) {
  const http = await import('node:http');
  const seen = [];
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://local').pathname;
    seen.push({ path, host: req.headers.host });
    const route = routes[path] ?? { status: 404, body: 'not here' };
    res.writeHead(route.status ?? 200, { 'content-type': 'text/html; charset=utf-8', ...(route.location ? { location: route.location } : {}) });
    res.end(route.body ?? '');
  });
  await new Promise(done => (socket ? server.listen(socket, done) : server.listen(0, '127.0.0.1', done)));
  return { origin: socket ? `unix:${socket}` : `http://127.0.0.1:${server.address().port}`, seen,
    close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }) };
}

const liveRoutes = { '/': { body: tall(3490) }, '/courses/yoga': { body: tall(3490) }, '/members': { status: 302, location: '/sign-in' }, '/sign-in': { body: tall(1200) } };
const candidateRun = async (candidateRoutes, more = {}) => {
  const live = await stand(liveRoutes);
  const candidate = candidateRoutes === 'live' ? live : await stand(candidateRoutes, more.socket);
  try {
    return { result: await checkCandidate({ candidate: candidate.origin, live: live.origin, paths: ['/', '/courses/yoga', '/members'], out: mkdtempSync(join(tmpdir(), 'site-build-out-')), settings, browser, ...more.options }), candidate, live };
  } finally {
    await live.close();
    if (candidate !== live) await candidate.close();
  }
};

test('a candidate that is the live site itself passes every kind, the signed-out redirect included', async () => {
  const { result } = await candidateRun('live');
  assert.equal(result.refused, 0, JSON.stringify(result.pages.map(row => [row.kind, row.why])));
  assert.deepEqual(result.pages.map(row => row.kind), ['/', '/courses/*', '/members']);
  assert.equal(byKind(result, '/members').height_px > 0, true);
});

test('a candidate that serves a blank page is refused for that kind', async () => {
  const { result } = await candidateRun({ ...liveRoutes, '/courses/yoga': { body: page({}) } });
  assert.equal(byKind(result, '/courses/*').refused, true);
  assert.match(byKind(result, '/courses/*').why.join(' '), /refused under 0.5/);
  assert.equal(byKind(result, '/').refused, false);
});

test('a candidate whose page throws is refused for the new page error', async () => {
  const { result } = await candidateRun({ ...liveRoutes, '/': { body: page({ body: '<div style="height:3490px"><p>text</p></div>', script: 'const course = {}; course.name.toUpperCase();' }) } });
  assert.equal(byKind(result, '/').refused, true);
  assert.match(byKind(result, '/').why.join(' '), /toUpperCase/);
});

test('a signed-out page must answer what live answers: a page where live redirects is refused, the same redirect passes', async () => {
  const drawn = await candidateRun({ ...liveRoutes, '/members': { body: tall(1200) } });
  const row = byKind(drawn.result, '/members');
  assert.equal(row.refused, true);
  assert.match(row.why.join(' '), /first answers 200 here and 302 to \/sign-in on the live site/);
  assert.match(row.why.join(' '), /the browser ends at \/members here and at \/sign-in on the live site/);
  const elsewhere = await candidateRun({ ...liveRoutes, '/members': { status: 302, location: '/log-in' }, '/log-in': { body: tall(1200) } });
  assert.match(byKind(elsewhere.result, '/members').why.join(' '), /302 to \/log-in here and 302 to \/sign-in/);
});

test('the candidate is asked as the live host, also through a unix socket; an unreachable candidate is refused, never read as a page', async () => {
  const socket = join(mkdtempSync(join(tmpdir(), 'site-build-sock-')), 'unit.sock');
  const { result, candidate, live } = await candidateRun(liveRoutes, { socket });
  assert.equal(result.refused, 0, JSON.stringify(result.pages.map(row => [row.kind, row.why])));
  assert.ok(candidate.seen.length > 0);
  for (const asked of candidate.seen) assert.equal(asked.host, new URL(live.origin).host);
  const gone = await stand(liveRoutes);
  try {
    const missing = await checkCandidate({ candidate: `unix:${join(tmpdir(), 'no-such-unit.sock')}`, live: gone.origin, paths: ['/'], out: mkdtempSync(join(tmpdir(), 'site-build-out-')), settings, browser });
    assert.equal(missing.refused, 1);
    assert.match(missing.pages[0].why[0], /the candidate could not be read/);
  } finally {
    await gone.close();
  }
});

test('a whole address on the live app host goes to the candidate app, as that host', async () => {
  const live = await stand(liveRoutes);
  const liveApp = await stand({ '/sign-in': { body: tall(900) } });
  const candidate = await stand(liveRoutes);
  const candidateApp = await stand({ '/sign-in': { body: tall(900) } });
  try {
    const result = await checkCandidate({ candidate: candidate.origin, candidateApp: candidateApp.origin, live: live.origin, liveApp: liveApp.origin,
      paths: ['/', `${liveApp.origin}/sign-in`], out: mkdtempSync(join(tmpdir(), 'site-build-out-')), settings, browser });
    assert.equal(result.refused, 0, JSON.stringify(result.pages.map(row => [row.kind, row.why])));
    assert.ok(result.pages.some(row => row.kind === `${new URL(liveApp.origin).host} /sign-in`));
    assert.ok(candidateApp.seen.some(asked => asked.path === '/sign-in' && asked.host === new URL(liveApp.origin).host));
  } finally {
    for (const one of [live, liveApp, candidate, candidateApp]) await one.close();
  }
});

test('exactly one of a built folder and a candidate is checked; a candidate is an address', () => {
  assert.throws(() => checkWhatIsChecked({ live: 'https://live.example' }), /never neither or both/);
  assert.throws(() => checkWhatIsChecked({ live: 'https://live.example', pages: '/built', candidate: 'http://127.0.0.1:9' }), /never neither or both/);
  assert.throws(() => checkWhatIsChecked({ live: 'https://live.example', candidate: '/a/folder' }), /http\(s\) origin or unix/);
  assert.throws(() => checkWhatIsChecked({ live: 'https://live.example', candidate: 'http://127.0.0.1:9', 'server-rendered': '/articles' }), /checked whole/);
  checkWhatIsChecked({ live: 'https://live.example', candidate: 'unix:/run/unit.sock' });
  checkWhatIsChecked({ live: 'https://live.example', pages: '/built' });
  assert.deepEqual(argumentsOfRequest({ candidate: 'http://10.0.0.5:8081', live: 'https://live.example', paths: ['/', '/members'], pages: '' }),
    { candidate: 'http://10.0.0.5:8081', live: 'https://live.example', paths: '/,/members' });
});

test('a candidate sitemap of many pages opens one page per kind, and a kind live lacks gets the new-page rule', async () => {
  const courses = Array.from({ length: 40 }, (_, at) => `/courses/c${at}`);
  const map = sitemap(['/', ...courses, '/events/opening', '/events/closing']);
  const routes = { ...liveRoutes, '/sitemap.xml': { body: map }, ...Object.fromEntries(courses.map(path => [path, { body: tall(3490) }])) };
  const drawn = await candidateRun({ ...routes, '/events/opening': { body: page({ body: '<p>We open in spring.</p>' }) } });
  assert.deepEqual(drawn.result.pages.map(row => row.kind), ['/', '/courses/*', '/members', '/events/*']);
  assert.equal(byKind(drawn.result, '/events/*').live_height_px, null);
  assert.equal(byKind(drawn.result, '/events/*').refused, false);
  const throws = await candidateRun({ ...routes, '/events/opening': { body: page({ body: '<p>We open in spring.</p>', script: 'null.x' }) } });
  assert.match(byKind(throws.result, '/events/*').why[0], /no live page exists and the built page threw/);
  const blank = await candidateRun({ ...routes, '/events/opening': { body: page({}) } });
  assert.match(byKind(blank.result, '/events/*').why.join(' '), /shows no text/);
});
