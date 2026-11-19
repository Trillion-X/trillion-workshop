// examples/standalone-workspace/check.mjs
//
// The headless-browser check of the example page: serves the built page, clicks each sidebar entry, asserts the
// screen mounted in the arrangement, and saves a screenshot after each click. Every request that is not to the local
// server is aborted, so the page runs with no network.
//   node tools/workspace-screens/web/examples/standalone-workspace/check.mjs <builtDir> <screenshotDir>
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { SURFACES } from './seeds.ts';

const [builtArg, shotsArg] = process.argv.slice(2);
if (!builtArg || !shotsArg) throw new Error('usage: check.mjs <builtDir> <screenshotDir>');
const built = resolve(builtArg);
const shots = resolve(shotsArg);
mkdirSync(shots, { recursive: true });

// Words each screen draws once it is mounted, by entry name (the lesson is opened from the course list).
const SHOWS = { courses: 'Starting out', posts: 'No posts yet', chat: 'Conversations', account: 'Your account', lesson: 'Course lesson' };

// The entries the page offers, in sidebar order: the sidebar label and the screen's entry name (seeds.ts).
const ENTRIES = SURFACES.map(({ payload }) => ({ label: payload.label, entry: payload.package_entry.entry_name }));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

const server = createServer((request, response) => {
  const file = join(built, request.url === '/' ? 'index.html' : decodeURIComponent(request.url.split('?')[0]));
  if (!file.startsWith(built) || !existsSync(file)) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  response.end(readFileSync(file));
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}/index.html`;

// The headless shell Playwright installed for this Chromium build (chromium_headless_shell-1243), found in its cache.
const cache = join(homedir(), 'Library/Caches/ms-playwright');
const shellDir = readdirSync(cache).filter(name => name.startsWith('chromium_headless_shell-1243')).sort().at(-1);
const shellFolder = readdirSync(join(cache, shellDir)).find(name => name.startsWith('chrome-headless-shell-'));
const executablePath = join(cache, shellDir, shellFolder, 'chrome-headless-shell');

const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
const outside = [];
page.on('pageerror', error => errors.push(String(error.message).slice(0, 300)));
await page.route('**/*', route => {
  if (route.request().url().startsWith(`http://127.0.0.1:${server.address().port}/`)) return route.continue();
  outside.push(route.request().url().slice(0, 200));
  return route.abort();
});

const results = [];
try {
  await page.goto(url, { waitUntil: 'load' });
  // The sidebar draws its rows outside #sidebar (a fixed rail), so an entry is a leaf outside the arrangement.
  const entryText = label => page.locator(`xpath=//*[not(*) and normalize-space(.)="${label}" and not(ancestor::*[@id="arrangement"])]`);
  for (const { label } of ENTRIES) {
    await entryText(label).first().waitFor({ state: 'visible', timeout: 30000 });
  }
  // A screen counts as mounted when words only it draws show in the arrangement (its heading or its first line).
  const arrangement = page.locator('#arrangement');
  for (const { label, entry } of ENTRIES) {
    await entryText(label).first().click();
    const shown = arrangement.getByText(SHOWS[entry]).first();
    let mounted = true;
    try { await shown.waitFor({ state: 'visible', timeout: 20000 }); } catch { mounted = false; }
    await page.mouse.move(1100, 700);
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(shots, `${entry}.png`) });
    results.push({ label, entry, mounted, panes: await arrangement.getByText(SHOWS[entry]).count() });
  }
  // The course path: open a lesson from the course list, check its video loads, mark it done, and read the done row back.
  await entryText('Courses').first().click();
  await arrangement.getByRole('button', { name: 'Open Welcome' }).click();
  await arrangement.getByText(SHOWS.lesson).first().waitFor({ state: 'visible', timeout: 20000 });
  await arrangement.locator('video').first().waitFor({ state: 'attached', timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#arrangement video')?.readyState >= 1, null, { timeout: 20000 });
  const videoSource = await arrangement.locator('video').first().evaluate(video => video.currentSrc);
  await page.mouse.move(1100, 700);
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(shots, 'lesson-open.png') });
  await arrangement.getByRole('button', { name: 'Mark done' }).click();
  await arrangement.getByRole('button', { name: 'Done', exact: true }).waitFor({ state: 'visible', timeout: 20000 });
  const doneRows = (await page.evaluate(() => window.seededRecords())).filter(row => row.type === 'record:lesson-done');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shots, 'lesson-done.png') });
  const doneOk = doneRows.length === 1 && doneRows[0].value.course_id === 'course-intro' && doneRows[0].value.lesson_id === 'lesson-1';
  results.push({ label: 'Lesson Welcome: video loads, Mark done writes the done row', entry: 'lesson-flow', mounted: doneOk && videoSource.endsWith('sample-lesson.webm'), panes: doneRows.length });
} finally {
  await browser.close();
  server.close();
}

for (const result of results) console.log(`${result.mounted ? 'PASS' : 'FAIL'} ${result.label} -> ${result.entry} (matches: ${result.panes})`);
console.log(`page errors: ${errors.length}${errors.length ? ` ${JSON.stringify(errors)}` : ''}`);
console.log(`requests outside the local server, aborted: ${outside.length}`);
if (results.some(result => !result.mounted)) process.exitCode = 1;
