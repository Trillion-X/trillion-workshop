// tools/page-critic: rendered-page rules for accessible names, Tab order, heading order and page metadata (F-1149),
// each a one-line `says` in read-data/page-craft-rules.json measured by do-work/measure-page-rules.mjs. Controls with
// no accessible name are the older control_name rule (Chromium's accessibility tree), reused rather than repeated;
// tab_order_positive, tab_order_backwards, heading_skip, heading_h1_count, page_title, page_lang, page_description and
// page_viewport are new. The critic runs end to end against planted local pages in Playwright's Chromium (only the
// widths and the settle wait are shortened); a clean page must stay quiet.
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
const NEW_RULES = ['tab_order_positive', 'tab_order_backwards', 'heading_skip', 'heading_h1_count', 'page_title', 'page_lang', 'page_description', 'page_viewport'];
const RULES = ['control_name', ...NEW_RULES];

const PAGES = {
  // No lang, an empty title, no description, no viewport; a positive tabindex at the bottom, two links whose order the
  // screen reverses, a skipped heading level, two h1s and a button with no name.
  '/planted': `<!doctype html><html><head><meta charset="utf-8"><title> </title><style>body{font:16px/1.5 sans-serif;margin:0;padding:24px} .flip{display:flex;flex-direction:column-reverse;gap:300px}</style></head><body>
    <a href="#home">Home</a>
    <h1>Planted page</h1>
    <h2>Plans</h2>
    <h4>Detail</h4>
    <div class="flip"><a href="#first">First in the page</a><a href="#second">Second in the page</a></div>
    <h1>Another top heading</h1>
    <button></button>
    <button tabindex="3">Jump first</button>
  </body></html>`,
  '/no-h1': `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="A page with sections only."><title>No top heading</title></head><body><h2>Only a section heading</h2><p>Some words.</p></body></html>`,
  '/clean': `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="A clean page for the rendered-page rules."><title>A clean page</title><style>body{font:16px/1.5 sans-serif;margin:0;padding:24px}</style></head><body>
    <a href="#main">Skip to the plans</a>
    <main id="main"><h1>A clean page</h1>
      <h2>Plans</h2><h3>This week</h3><p>Plan the week.</p>
      <h2>Reviews</h2><p><a href="#main">Back to the top</a></p>
      <button>Save the plan</button><button aria-label="Close"><svg width="16" height="16" aria-hidden="true"></svg></button>
      <div role="heading" aria-level="3">A heading by role</div>
    </main></body></html>`,
};

async function critique(path) {
  const server = createServer((request, answer) => answer.writeHead(PAGES[request.url] ? 200 : 404, { 'content-type': 'text/html' }).end(PAGES[request.url] ?? 'missing'));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const folder = mkdtempSync(join(tmpdir(), 'page-critic-page-rules-'));
  try {
    const rules = join(folder, 'rules.json');
    writeFileSync(rules, JSON.stringify({ ...craft, widths: craft.widths.filter(width => width.id !== '240'), settle_ms: 400, rules: craft.rules.filter(rule => RULES.includes(rule.id)) }));
    const child = spawn(process.execPath, [critic, '--url', `http://127.0.0.1:${server.address().port}${path}`, '--out', folder, '--rules', rules], { env: { ...process.env, BROWSER_EXECUTABLE: chromium.executablePath() } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const status = await new Promise(done => child.on('close', done));
    assert.equal(status, 0, stderr);
    return JSON.parse(stdout.trim().split('\n').at(-1));
  } finally { rmSync(folder, { recursive: true, force: true }); await new Promise(done => server.close(done)); }
}

const of = (report, rule, width = '1280') => report.findings.filter(item => item.rule === rule && item.width === width);

test('each rule is a data row whose words fit on one line, and control_name is the accessible-name rule', () => {
  for (const id of NEW_RULES) {
    const rule = craft.rules.find(row => row.id === id);
    assert.ok(rule?.says && rule.widths?.length, `${id} has a row`);
    for (const said of [rule.says, ...Object.values(rule.says_by_kind ?? {})]) assert.ok(!said.includes('\n') && said.length <= 160, `${id} says one line`);
    assert.match(rule.from, /F-1149/);
  }
  assert.equal(craft.rules.filter(row => /accessible name/.test(row.says)).map(row => row.id).join(), 'control_name');
  assert.ok(craft.rules.find(row => row.id === 'tab_order_backwards').max_jump_up_px > 0);
  assert.equal(craft.rules.find(row => row.id === 'heading_h1_count').most, 1);
});

test('a planted page is flagged for each rule, and the nameless button by control_name', { timeout: 120000 }, async () => {
  const report = await critique('/planted');
  const says = rule => of(report, rule).map(item => item.says);
  assert.deepEqual(says('page_title'), ["The page's <title> is missing or empty; name the page in it."]);
  assert.deepEqual(says('page_lang'), ['The page has no <html lang>; name its language.']);
  assert.deepEqual(says('page_description'), ['The page has no meta description; add one that says what the page is.']);
  assert.equal(says('page_viewport').length, 1);
  assert.deepEqual(says('tab_order_positive'), ['"Jump first" has tabindex 3; positive tabindex breaks the Tab order, use 0 or the page\'s order.']);
  const backwards = says('tab_order_backwards');
  assert.ok(backwards.some(said => /^Tab moves from "Jump first" back up \d+px to "Home"/.test(said)), JSON.stringify(backwards));
  assert.ok(backwards.some(said => /^Tab moves from "First in the page" back up \d+px to "Second in the page"/.test(said)), JSON.stringify(backwards));
  assert.ok(of(report, 'tab_order_backwards', '390').length, 'and on a phone');
  assert.deepEqual(says('heading_skip'), ['The heading "Detail" is an h4 right after an h2; do not skip heading levels.']);
  assert.deepEqual(says('heading_h1_count'), ['The page has 2 h1 headings (another is "Another top heading"); keep at most 1.']);
  assert.ok(of(report, 'heading_h1_count')[0].rect, 'the second h1 is boxed');
  assert.ok(of(report, 'control_name').some(item => /^The button control has no accessible name/.test(item.says)), JSON.stringify(of(report, 'control_name')));
});

test('a page with no h1 is told to give it one', { timeout: 120000 }, async () => {
  const report = await critique('/no-h1');
  assert.deepEqual(of(report, 'heading_h1_count').map(item => item.says), ['The page has no h1; give it exactly one.']);
  assert.deepEqual(report.findings.filter(item => item.rule !== 'heading_h1_count' && RULES.includes(item.rule)).map(item => item.says), []);
});

test('a clean page stays quiet under every rule at both widths', { timeout: 120000 }, async () => {
  const report = await critique('/clean');
  assert.deepEqual(report.findings.filter(item => RULES.includes(item.rule)).map(item => `${item.width} ${item.rule}: ${item.says}`), []);
  assert.equal(report.pictures.length, 2);
});
