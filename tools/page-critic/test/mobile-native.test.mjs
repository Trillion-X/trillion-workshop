// tools/page-critic: two phone rules from the MIT-licensed mobile-native skill (github.com/emilkowalski/skills), as rows
// of read-data/page-craft-rules.json. input_zoom: a field whose text is under 16px makes a phone zoom the page when it
// is tapped. sticky_hover: a :hover look outside @media (hover: hover) sticks after a tap. The critic runs end to end
// against a planted local page in Playwright's Chromium.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PAGE = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font: 16px/1.5 system-ui; padding: 24px; }
  .small { font-size: 14px; }
  .big { font-size: 16px; }
  a.bare:hover { color: red; }
  @media (hover: hover) { a.guarded:hover { color: red; } }
  @media (any-pointer: fine) and (hover: hover) { button.also-guarded:hover { color: red; } }
</style></head><body>
  <main>
    <p>Two fields, two links and a button, each one planted to pass or fail one phone rule.</p>
    <input class="small" aria-label="Small search" />
    <input class="big" aria-label="Readable search" />
    <input type="checkbox" aria-label="A checkbox is not a text field" style="font-size: 10px" />
    <p><a class="bare" href="#top">Bare hover link</a> <a class="guarded" href="#top">Guarded hover link</a></p>
    <button class="also-guarded">Guarded button</button>
  </main>
</body></html>`;

test('the phone rules are rows: input_zoom at 16px and sticky_hover with its pointer-only media, both at 390 only', () => {
  const rules = JSON.parse(readFileSync(new URL('../read-data/page-craft-rules.json', import.meta.url), 'utf8')).rules;
  const zoom = rules.find(rule => rule.id === 'input_zoom');
  const hover = rules.find(rule => rule.id === 'sticky_hover');
  assert.equal(zoom.min_px, 16);
  assert.deepEqual([zoom.widths, hover.widths], [['390'], ['390']]);
  const guarded = new RegExp(hover.hover_media, 'i');
  assert.deepEqual(['(hover: hover)', '(any-hover:hover)', '(min-width: 40em) and (pointer: fine)', '(hover: none)', '(pointer: coarse)', 'screen'].map(media => guarded.test(media)), [true, true, true, false, false, false]);
});

test('the critic finds the small field and the unguarded hover, and passes the rest', { timeout: 120000 }, async () => {
  const server = createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(PAGE); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const out = mkdtempSync(join(tmpdir(), 'page-craft-mobile-native-'));
  try {
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../do-work/critique-a-page.mjs', import.meta.url)), '--url', `http://127.0.0.1:${server.address().port}/`, '--out', out], { env: { ...process.env, BROWSER_EXECUTABLE: chromium.executablePath() }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', errors = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('the critic did not finish within 110 seconds')); }, 110000);
      child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error(`the critic exited ${code ?? signal}: ${errors}`)); });
    });
    const report = JSON.parse(stdout.trim().split('\n').at(-1));
    const of = rule => report.findings.filter(finding => finding.rule === rule);
    assert.deepEqual(of('input_zoom').map(finding => [finding.width, finding.text]), [['390', 'Small search']]);
    assert.match(of('input_zoom')[0].says, /14px text; a phone zooms the whole page/);
    assert.deepEqual(of('sticky_hover').map(finding => [finding.width, finding.text]), [['390', 'a.bare:hover']]);
    assert.ok(of('sticky_hover')[0].rect, 'the finding is boxed on the element the hover look belongs to');
  } finally {
    rmSync(out, { recursive: true, force: true });
    await new Promise(done => server.close(done));
  }
});
