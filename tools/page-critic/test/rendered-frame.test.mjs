// tools/page-critic: the rendered frame check (F-1117), as rows of read-data/page-craft-rules.json measured by
// do-work/measure-rendered-frame.mjs. On the rendered first screen and the whole page at each width: side margins too
// small or lopsided, a section whose content is pushed to one side, a blank stretch, no title on the first screen, a
// section with no heading, and text crowding the left edge. Text touching the browser's edge is the older
// edge_padding rule, reused here rather than repeated. The critic runs end to end against planted local pages in
// Playwright's Chromium (only the widths and the settle wait are shortened); a clean page must stay quiet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const critic = fileURLToPath(new URL('../do-work/critique-a-page.mjs', import.meta.url));
const craft = JSON.parse(readFileSync(new URL('../read-data/page-craft-rules.json', import.meta.url), 'utf8'));
const FRAME_RULES = ['screen_side_margins', 'lopsided_section', 'blank_stretch', 'no_first_screen_title', 'untitled_section', 'left_edge_crowding'];
const RULES = [...FRAME_RULES, 'edge_padding'];

const words = count => Array.from({ length: count }, (_, at) => ['plan', 'review', 'send', 'draft', 'share', 'check'][at % 6]).join(' ');
const page = (style, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Frame fixture</title><style>body{font:16px/1.5 sans-serif;margin:0} ${style}</style></head><body>${body}</body></html>`;
const PAGES = {
  // Everything sits 40px from the left and far from the right; one section keeps a narrow column to its left side,
  // one long section has no heading, a tall empty stretch follows, and no text on the first screen is a title.
  '/lopsided': page('.wrap{margin-left:40px;width:1100px} .narrow{max-width:300px}', `
    <div class="wrap">
      <p>Weekly planning notes for the team.</p>
      <section id="pushed"><h2>Pushed aside</h2><p class="narrow">Only a short column at the left of a wide section.</p></section>
      <section id="nameless"><p>${words(60)}</p></section>
      <div style="height:1400px"></div>
      <p>The end of the notes.</p>
    </div>`),
  // Text pressed 6px from the left edge in a half-width column: small margins, crowding and edge text.
  '/crowded': page('main{padding-left:6px;width:50%} h1{font-size:36px;margin:0}', `
    <main><h1>Crowded page</h1><p>First short line.</p><p>Second short line.</p><p>Third short line.</p><p>Fourth short line.</p></main>`),
  // A centred column with even margins, a title, a heading on every section and no empty stretch.
  '/clean': page('main{max-width:720px;margin:0 auto;padding:24px} h1{font-size:36px;margin:0 0 16px}', `
    <main><h1>A clean frame</h1><p>${words(30)}</p>
      <section><h2>Plans</h2><p>${words(60)}</p></section>
      <section><h2>Reviews</h2><p>${words(60)}</p></section>
      <div style="height:300px"></div>
      <section><h2>Sending</h2><p>${words(20)}</p></section></main>`),
};

async function critique(url, folder) {
  const rules = join(folder, 'rules.json');
  writeFileSync(rules, JSON.stringify({ ...craft, widths: craft.widths.filter(width => width.id !== '240'), settle_ms: 400, rules: craft.rules.filter(rule => RULES.includes(rule.id)) }));
  const child = spawn(process.execPath, [critic, '--url', url, '--out', folder, '--rules', rules], { env: { ...process.env, BROWSER_EXECUTABLE: chromium.executablePath() } });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const status = await new Promise(done => child.on('close', done));
  assert.equal(status, 0, stderr);
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

async function withSite(path, check) {
  const server = createServer((request, answer) => answer.writeHead(PAGES[request.url] ? 200 : 404, { 'content-type': 'text/html' }).end(PAGES[request.url] ?? 'missing'));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const folder = mkdtempSync(join(tmpdir(), 'page-critic-frame-'));
  try { await check(await critique(`http://127.0.0.1:${server.address().port}${path}`, folder)); } finally { rmSync(folder, { recursive: true, force: true }); await new Promise(done => server.close(done)); }
}

const of = (report, rule, width = '1280') => report.findings.filter(item => item.rule === rule && item.width === width);

test('each frame rule is a data row with its own words and thresholds, and edge text stays the edge_padding row', () => {
  for (const id of FRAME_RULES) {
    const rule = craft.rules.find(row => row.id === id);
    assert.ok(rule?.says && rule.widths?.length, `${id} has a row that says what is wrong at named widths`);
    assert.match(rule.from, /F-1117/);
  }
  const rule = id => craft.rules.find(row => row.id === id);
  assert.ok(rule('screen_side_margins').min_px > 0 && rule('screen_side_margins').max_difference_px > 0);
  assert.ok(rule('lopsided_section').max_imbalance > 0 && rule('blank_stretch').max_screens > 0 && rule('untitled_section').min_words > 0);
  assert.ok(rule('no_first_screen_title').min_title_px > 0 && rule('left_edge_crowding').within_px > 0);
  assert.equal(craft.rules.filter(row => /edge/.test(row.id) && /from the edge|edge of the browser/.test(row.says)).length, 1, 'one rule says text is too close to the edge');
});

test('a lopsided page is flagged for its margins, a pushed section, a blank stretch, no title and a nameless section', { timeout: 120000 }, async () => {
  await withSite('/lopsided', report => {
    const margins = of(report, 'screen_side_margins');
    assert.deepEqual(margins.map(item => item.says), [
      "On the first screen the content's margins are 40px on the left and 140px on the right; keep them within 48px of each other.",
      "On the whole page the content's margins are 40px on the left and 140px on the right; keep them within 48px of each other.",
    ]);
    const pushed = of(report, 'lopsided_section');
    assert.equal(pushed.length, 1, JSON.stringify(pushed));
    assert.match(pushed[0].selector, /section#pushed$/);
    assert.match(pushed[0].says, /keeps its content to the left \(0px on the left, [89]\d\dpx on the right\)/);
    const blank = of(report, 'blank_stretch');
    assert.equal(blank.length, 1, JSON.stringify(blank));
    assert.match(blank[0].says, /^14\d\dpx of the page from \d+px down shows nothing; keep empty stretches under 645px\.$/);
    assert.ok(blank[0].rect.height >= 1400);
    assert.match(of(report, 'no_first_screen_title')[0]?.says ?? '', /^The first screen \(860px\) shows no title/);
    const nameless = of(report, 'untitled_section');
    assert.equal(nameless.length, 1);
    assert.match(nameless[0].selector, /section#nameless$/);
    assert.equal(of(report, 'left_edge_crowding').length, 0, 'text 40px from the edge is not crowding it');
    assert.ok(of(report, 'no_first_screen_title', '390').length, 'and the missing title is seen on a phone too');
  });
});

test('a crowded page is flagged for small margins, left-edge crowding and (through edge_padding) edge text', { timeout: 120000 }, async () => {
  await withSite('/crowded', report => {
    assert.match(of(report, 'screen_side_margins')[0]?.says ?? '', /^On the first screen the content comes 6px from the left edge and \d+px from the right; keep at least 16px on both sides\.$/);
    const crowded = of(report, 'left_edge_crowding');
    assert.equal(crowded.length, 1);
    assert.match(crowded[0].says, /^5 blocks of text crowd within 32px of the left edge/);
    assert.ok(crowded[0].rect.width > 0);
    assert.ok(of(report, 'edge_padding').some(item => /"Crowded page" sits 6px from the edge/.test(item.says)), 'edge text is the edge_padding rule');
    assert.equal(of(report, 'no_first_screen_title').length, 0, 'the 36px h1 is a title');
  });
});

test('a clean, centred page stays quiet under every frame rule at both widths', { timeout: 120000 }, async () => {
  await withSite('/clean', report => {
    assert.deepEqual(report.findings.filter(item => RULES.includes(item.rule)).map(item => `${item.width} ${item.rule}: ${item.says}`), []);
    assert.equal(report.pictures.length, 2);
  });
});
