// tools/page-critic: the reduced-motion second pass (F-1119), the reduced_motion_hidden row of
// read-data/page-craft-rules.json measured by do-work/measure-reduced-motion.mjs. The critic opens the page again
// with the browser asking for reduced motion (prefers-reduced-motion: reduce, emulated through DevTools); text that was
// on the first screen and seen in the ordinary pass but stays hidden under reduced motion (see-through, visibility
// hidden, not displayed, moved off the screen, clipped) is a finding naming the text. A page that turns its
// animations off by showing the end state must stay quiet. Runs end to end in Playwright's Chromium.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { reducedMotionFindings } from '../do-work/measure-reduced-motion.mjs';

const critic = fileURLToPath(new URL('../do-work/critique-a-page.mjs', import.meta.url));
const craft = JSON.parse(readFileSync(new URL('../read-data/page-craft-rules.json', import.meta.url), 'utf8'));
const rule = craft.rules.find(row => row.id === 'reduced_motion_hidden');

// Five reveals, each one a way an entrance animation can leave its text hidden when motion is turned off.
const ANIMATED = `
  @keyframes show { to { opacity: 1; } }
  @keyframes slide { to { transform: none; } }
  @keyframes appear { to { visibility: visible; } }
  .fade { opacity: 0; animation: show .2s forwards; }
  .mask { overflow: hidden; height: 1.5em; line-height: 1.5; }
  .mask span { display: block; transform: translateY(100%); animation: slide .2s forwards; }
  .appear { visibility: hidden; animation: appear .2s forwards; }
  .reveal { transform: translateX(-200vw); transition: transform .2s; }
  .reveal.in { transform: none; }
  .late { display: none; }
  .late.in { display: block; }
  .never { opacity: 0; }`;
const BODY = `
  <main>
    <h1 class="fade">Plan the week</h1>
    <div class="mask"><span>Every task in one place</span></div>
    <p class="appear">Shared with the whole team</p>
    <p class="reveal">Sent on time</p>
    <p class="late">Reviewed each Friday</p>
    <p class="never">Never shown at all</p>
    <p>Always shown</p>
    <div style="height: 2400px"></div>
    <p class="fade">Below the first screen</p>
  </main>
  <script>
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) setTimeout(() => document.querySelectorAll('.reveal, .late').forEach(element => element.classList.add('in')), 50);
  </script>`;
const page = style => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Motion fixture</title><style>body{font:16px/1.5 sans-serif;margin:0;padding:24px} ${style}</style></head><body>${BODY}</body></html>`;
const PAGES = {
  // Under reduced motion the animations are switched off and the hidden start state stays.
  '/planted': page(`${ANIMATED} @media (prefers-reduced-motion: reduce) { .fade, .mask span, .appear { animation: none; } }`),
  // Under reduced motion the animations are switched off and the end state is shown at once.
  '/clean': page(`${ANIMATED} @media (prefers-reduced-motion: reduce) { .fade, .mask span, .appear { animation: none; opacity: 1; transform: none; visibility: visible; } .reveal { transform: none; transition: none; } .late { display: block; } }`),
};

async function critique(path) {
  const server = createServer((request, answer) => answer.writeHead(PAGES[request.url] ? 200 : 404, { 'content-type': 'text/html' }).end(PAGES[request.url] ?? 'missing'));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const folder = mkdtempSync(join(tmpdir(), 'page-critic-motion-'));
  try {
    const rules = join(folder, 'rules.json');
    writeFileSync(rules, JSON.stringify({ ...craft, widths: craft.widths.filter(width => width.id !== '240'), settle_ms: 400, rules: [{ ...rule, settle_ms: 600 }] }));
    const child = spawn(process.execPath, [critic, '--url', `http://127.0.0.1:${server.address().port}${path}`, '--out', folder, '--rules', rules], { env: { ...process.env, BROWSER_EXECUTABLE: chromium.executablePath() } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const status = await new Promise(done => child.on('close', done));
    assert.equal(status, 0, stderr);
    return JSON.parse(stdout.trim().split('\n').at(-1));
  } finally { rmSync(folder, { recursive: true, force: true }); await new Promise(done => server.close(done)); }
}

test('the reduced-motion pass is a data row: its settle wait, its opacity and clipping thresholds and every reason it gives', () => {
  assert.ok(rule.settle_ms > 0 && rule.min_opacity > 0 && rule.min_shown_fraction > 0 && rule.widths.length);
  assert.deepEqual(Object.keys(rule.reasons).sort(), ['clipped', 'display', 'gone', 'off_screen', 'opacity', 'visibility']);
  assert.match(rule.from, /F-1119/);
  const ordinary = [
    { key: 'a', text: 'Seen then hidden', selector: 'p.a', hidden: null, first: true, rect: { x: 0, y: 0, width: 10, height: 10 } },
    { key: 'b', text: 'Seen then gone', selector: 'p.b', hidden: null, first: true, rect: null },
    { key: 'c', text: 'Below the fold', selector: 'p.c', hidden: null, first: false, rect: null },
    { key: 'd', text: 'Hidden in both', selector: 'p.d', hidden: 'opacity', first: true, rect: null },
  ];
  const reduced = [{ ...ordinary[0], hidden: 'opacity' }, { ...ordinary[2], hidden: 'opacity' }, ordinary[3]];
  assert.deepEqual(reducedMotionFindings(ordinary, reduced, rule).map(item => [item.text, item.values.reason]), [['Seen then hidden', 'see-through'], ['Seen then gone', 'no longer on the page']]);
});

test('first-screen text an animation reveals but reduced motion leaves hidden is flagged, naming the text and why', { timeout: 120000 }, async () => {
  const report = await critique('/planted');
  for (const width of ['390', '1280']) {
    const found = report.findings.filter(item => item.rule === 'reduced_motion_hidden' && item.width === width);
    assert.deepEqual(found.map(item => [item.text, item.says.match(/hidden \((.*?)\)/)[1]]), [
      ['Plan the week', 'see-through'],
      ['Every task in one place', 'clipped away'],
      ['Shared with the whole team', 'visibility hidden'],
      ['Sent on time', 'moved off the screen'],
      ['Reviewed each Friday', 'not displayed'],
    ], `${width}: ${JSON.stringify(found)}`);
    assert.match(found[0].says, /^"Plan the week" shows on the first screen but stays hidden \(see-through\) when the visitor asks for reduced motion/);
    assert.ok(found.every(item => item.selector && item.rect), 'each finding says where');
  }
});

test('a page whose reduced-motion styles show the end state stays quiet', { timeout: 120000 }, async () => {
  const report = await critique('/clean');
  assert.deepEqual(report.findings.filter(item => item.rule === 'reduced_motion_hidden').map(item => `${item.width}: ${item.says}`), []);
  assert.equal(report.pictures.length, 2);
});
