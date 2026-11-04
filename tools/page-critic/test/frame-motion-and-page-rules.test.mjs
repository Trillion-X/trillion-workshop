// tools/page-critic: the rendered frame (F-1117), the reduced-motion second pass (F-1119) and the one-line rules for the Tab
// order, the heading order and the page's metadata (F-1149; accessible names are control_name). The critic runs end to end
// in Playwright's Chromium against two planted local pages: one that breaks every rule, one that keeps them all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const LONG = 'A made-up paragraph about tide tables and harbour lights, long enough to read as a real section of a page. '.repeat(5);

const BROKEN = `<!doctype html><html><head><title>Planted broken page</title>
<style>
  body { margin: 0; font: 16px/1.5 system-ui; }
  main { margin-left: 40px; width: 900px; }
  .hero { opacity: 0; }
  @media (prefers-reduced-motion: no-preference) { .hero { animation: arrive 0.2s forwards; } }
  @keyframes arrive { to { opacity: 1; } }
  .row { display: flex; gap: 24px; }
  .row > div { flex: 1; }
</style></head><body>
  <main>
    <p class="hero">Harbour lights, planted to arrive with an animation</p>
    <div style="height: 1400px"></div>
    <h2>Opening hours</h2>
    <h4>Weekdays</h4>
    <h1>Planted broken page</h1>
    <section><p>${LONG}</p></section>
    <div class="row"><div><p>${LONG}</p><p>${LONG}</p><p>${LONG}</p></div><div><p>Short side.</p></div></div>
    <p><button tabindex="3">Jump ahead</button></p>
    <div aria-hidden="true"><button>Hidden from readers</button></div>
  </main>
</body></html>`;

const KEPT = `<!doctype html><html lang="en"><head><title>Planted kept page</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="A made-up page that keeps every rule.">
<style>
  body { margin: 0; font: 16px/1.5 system-ui; }
  main { margin: 0 auto; max-width: 900px; padding: 0 24px; }
  .hero { opacity: 1; }
  @media (prefers-reduced-motion: no-preference) { .hero { animation: arrive 0.2s; } }
  @keyframes arrive { from { opacity: 0; } }
  .row { display: flex; gap: 24px; }
  .row > div { flex: 1; }
</style></head><body>
  <main>
    <h1>Planted kept page</h1>
    <p class="hero">Harbour lights, shown with or without the animation</p>
    <section><h2>Tides</h2><p>${LONG}</p></section>
    <div class="row"><div><p>${LONG}</p></div><div><p>${LONG}</p></div></div>
    <h2>Opening hours</h2>
    <h3>Weekdays</h3>
    <p><button>Ask a question</button></p>
  </main>
</body></html>`;

const NEW_RULES = ['first_screen_title', 'untitled_section', 'lopsided_sections', 'blank_stretch', 'side_margins', 'reduced_motion_hidden', 'heading_order', 'tab_order', 'page_metadata'];

// The planted pages are served on loopback: the browser is not told any proxy, so a run inside a proxied sandbox still reaches them.
const LOCAL_ONLY = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^https?_proxy$/i.test(name)));

async function critique(path) {
  const server = createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(request.url === '/kept' ? KEPT : BROKEN); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const out = mkdtempSync(join(tmpdir(), 'page-craft-frame-'));
  try {
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../do-work/critique-a-page.mjs', import.meta.url)), '--url', `http://127.0.0.1:${server.address().port}${path}`, '--out', out], { env: { ...LOCAL_ONLY, BROWSER_EXECUTABLE: chromium.executablePath() }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', errors = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('the critic did not finish within 110 seconds')); }, 110000);
      child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error(`the critic exited ${code ?? signal}: ${errors}`)); });
    });
    return JSON.parse(stdout.trim().split('\n').at(-1));
  } finally {
    rmSync(out, { recursive: true, force: true });
    await new Promise(done => server.close(done));
  }
}

test('each new rule is one row with a one-line says, a width list and the finding it answers', () => {
  const rules = JSON.parse(readFileSync(new URL('../read-data/page-craft-rules.json', import.meta.url), 'utf8')).rules;
  for (const id of NEW_RULES) {
    const row = rules.find(rule => rule.id === id);
    assert.ok(row, id);
    assert.ok(!row.says.includes('\n') && row.widths.length > 0 && /^F-\d{4}$/.test(row.finding), id);
  }
});

test('the critic finds every planted break at 1280, and none on the page that keeps the rules', { timeout: 240000 }, async () => {
  const broken = await critique('/broken');
  const at = (rule, width = '1280') => broken.findings.filter(item => item.rule === rule && item.width === width);
  assert.equal(at('first_screen_title').length, 1);
  assert.match(at('untitled_section')[0].says, /has no title/);
  assert.match(at('lopsided_sections')[0].says, /Short side/);
  assert.match(at('blank_stretch')[0].says, /show nothing/);
  assert.match(at('side_margins')[0].says, /40px from the left/);
  assert.deepEqual(at('reduced_motion_hidden').map(item => item.text), ['Harbour lights, planted to arrive with an animation']);
  assert.deepEqual(at('reduced_motion_hidden', '390').map(item => item.text), ['Harbour lights, planted to arrive with an animation']);
  assert.deepEqual(at('heading_order').map(item => item.says).sort(), [
    'The first heading "Opening hours" is level 2; the page should start with its h1.',
    'The heading "Weekdays" is level 4 right after a level 2; do not skip a level.',
  ]);
  assert.deepEqual(at('tab_order').map(item => item.says).sort(), [
    '"Hidden from readers" can take focus with Tab but is hidden from screen readers (aria-hidden); hide both or neither.',
    '"Jump ahead" has tabindex 3, which moves it ahead of the page\'s own order; use 0 or leave it out.',
  ]);
  assert.deepEqual(at('page_metadata').map(item => item.says), [
    "The page has no language (html[lang]).",
    "The page has no viewport (meta[name='viewport']).",
    "The page has no description (meta[name='description']).",
  ]);
  const kept = await critique('/kept');
  assert.deepEqual(kept.findings.filter(item => NEW_RULES.includes(item.rule)).map(item => `${item.width} ${item.rule}: ${item.says}`), []);
});
