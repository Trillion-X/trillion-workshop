// The public-page critic (tools/page-critic) and the four rules that judge what a visitor actually sees: test_data,
// tiny_images, duplicate_cards and stale_demo. Each rule's thresholds, words and demo address patterns are DATA in
// read-data/page-craft-rules.json; this test runs the real rows (only the widths, waits and demo
// address pattern are shortened to suit a small local server) through the real script in a headless Chromium.
//
// A page with planted defects must be flagged by each rule, each finding naming what is wrong and where (selector and
// text), with a marked picture; a clean page built the same way must stay quiet.
//   - test data: an edition hash, a "real product screenshots" line, placeholder words and an example.com address in
//     a frame of another origin;
//   - tiny images: a screenshot a quarter the width of its card, shrunk past readable, and a small picture stretched;
//   - duplicate cards: two list items that differ only by their edition hash, and two titled alike inside a frame;
//   - stale demo: a demo frame that cannot be reached, answers 404, says "Your choice was not saved", or stays empty,
//     and a looping clip that does not load.
// Needs Chromium (Playwright's, from devDependencies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const critic = resolve(root, 'do-work/critique-a-page.mjs');
const craft = JSON.parse(readFileSync(resolve(root, 'read-data/page-craft-rules.json'), 'utf8'));
const NEW_RULES = ['test_data', 'tiny_images', 'duplicate_cards', 'stale_demo', 'repeated_supporting_text'];

// A solid-colour PNG of any size, and half a second of silence as a WAV (a clip a <video> can play).
function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, sum]);
  };
  const head = Buffer.alloc(13); head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 200)]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}
function wav(samples) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + samples, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(8000, 24); head.writeUInt32LE(8000, 28);
  head.writeUInt16LE(1, 32); head.writeUInt16LE(8, 34); head.write('data', 36); head.writeUInt32LE(samples, 40);
  return Buffer.concat([head, Buffer.alloc(samples, 128)]);
}

const page = html => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title><style>body{font:16px/1.4 sans-serif;margin:0;padding:24px} figure{width:600px;margin:0 0 24px} ul{padding:0;list-style:none} li{margin:4px 0}</style></head><body><main>${html}</main></body></html>`;

// The page under judgement is served on one port and the demos it embeds on another: the same site, another origin.
async function serve(demoPort) {
  const files = { '/shot.png': ['image/png', png(1200, 800)], '/small.png': ['image/png', png(160, 100)], '/photo.png': ['image/png', png(600, 400)], '/clip.wav': ['audio/wav', wav(4000)] };
  const demo = (body, status = 200) => [status, 'text/html', `<!doctype html><meta charset="utf-8"><body>${body}</body>`];
  const demos = {
    '/demo-ok': demo('<h1>Your workspace</h1><p>Three things need you today and nothing is overdue.</p><ul><li>Review the plan</li><li>Send the invoice</li></ul>'),
    '/demo-error': demo('<h1>Your workspace</h1><p>Your choice was not saved. Try again.</p><ul><li>Daily review</li><li>Daily review</li></ul><p>Contact placeholder@example.com for the sample data.</p>'),
    '/demo-404': demo('<p>Nothing lives here at all, sorry about that, truly.</p>', 404),
    '/demo-empty': demo(''),
  };
  const send = (answer, [status, type, body]) => answer.writeHead(status, { 'content-type': type }).end(body);
  const pages = {};
  const demoServer = createServer((request, answer) => { const found = demos[request.url]; send(answer, found ?? demo('missing', 404)); });
  const pageServer = createServer((request, answer) => {
    if (files[request.url]) return send(answer, [200, files[request.url][0], files[request.url][1]]);
    if (pages[request.url]) return send(answer, [200, 'text/html', pages[request.url]]);
    return send(answer, [404, 'text/plain', 'missing']);
  });
  await new Promise(done => demoServer.listen(0, '127.0.0.1', done));
  await new Promise(done => pageServer.listen(0, '127.0.0.1', done));
  const demoAt = `http://127.0.0.1:${demoServer.address().port}`;
  Object.assign(pages, {
    '/planted': page(`
      <h1>Use Trillion inside your AI chat.</h1>
      <p id="repeated-heading">Use Trillion inside your AI chat.</p>
      <p class="context">The examples below are real product screenshots from the workspace.</p>
      <ul class="feed"><li><h3>Field Notes reflection edition 93e28e69118e</h3></li><li><h3>Field Notes reflection edition a1b2c3d4e5f6</h3></li><li><h3>Weekly review</h3></li></ul>
      <figure class="shot"><img id="shot" src="/shot.png" alt="Product workspace screenshot of the files editor" style="width:240px;display:block;margin:0 auto"><figcaption>The files editor</figcaption></figure>
      <figure class="stretched"><img id="stretched" src="/small.png" alt="A small picture that is stretched wide" style="width:400px;display:block"><figcaption>Stretched</figcaption></figure>
      <video id="clip" src="/missing-clip.mp4" loop autoplay muted playsinline width="300"></video>
      <iframe id="demo-error" src="${demoAt}/demo-error" width="600" height="220"></iframe>
      <iframe id="demo-missing" src="${demoAt}/demo-404" width="600" height="120"></iframe>
      <iframe id="demo-empty" src="${demoAt}/demo-empty" width="600" height="120"></iframe>
      <iframe id="demo-down" src="http://127.0.0.1:1/demo-down" width="600" height="120"></iframe>`),
    '/clean': page(`
      <h1>Use Trillion inside your AI chat.</h1>
      <p>Connect an AI and bring up a screen in the conversation.</p>
      <section><h2>Upload a file</h2><p>Choose a JPEG or PNG under 8 MB.</p></section>
      <section><h2>Email address</h2><p><label for="email">Email address</label></p><input id="email"></section>
      <section><h2>Delete this file</h2><p id="delete-description">Delete this file</p><button aria-describedby="delete-description">Delete</button></section>
      <section><h2>Upload failed</h2><p role="alert">Upload failed</p></section>
      <section><h2>Uploading files</h2><p aria-live="polite">Uploading files</p></section>
      <section><h2>Save changes</h2><p><button>Save changes</button></p></section>
      <section><h2>Review terms</h2><p><a href="#terms">Review terms</a></p></section>
      <section><h2>Price each month</h2><p>Pay $20 today. Renews monthly until canceled.</p></section>
      <section><h2>Practice score</h2><p>A positive score means the player won more points than they lost.</p></section>
      <p>It runs it on a sample inside a sealed container. Runtime state boundaries, placeholder. We use our own test accounts.</p>
      <ul class="feed"><li><h3>Weekly review</h3></li><li><h3>Send the invoice</h3></li><li><h3>Plan the launch</h3></li></ul>
      <figure class="shot"><img id="photo" src="/photo.png" alt="A close crop of the files editor with its search box" style="width:100%;display:block"><figcaption>The files editor</figcaption></figure>
      <video id="clip" src="/clip.wav" loop autoplay muted playsinline width="300"></video>
      <iframe id="demo-ok" src="${demoAt}/demo-ok" width="600" height="220"></iframe>`),
  });
  return { base: `http://127.0.0.1:${pageServer.address().port}`, close: () => { pageServer.close(); demoServer.close(); } };
}

// The real rule rows, narrowed to the four rules, two widths, short waits and the local demo address.
function rulesFor(folder) {
  const rules = craft.rules.filter(rule => NEW_RULES.includes(rule.id)).map(rule => (rule.id === 'stale_demo' ? { ...rule, wait_seconds: 3, video_wait_seconds: 3, demo_url_patterns: ['^http://127\\.0\\.0\\.1:\\d+/demo'] } : rule));
  const file = join(folder, 'rules.json');
  writeFileSync(file, JSON.stringify({ ...craft, widths: craft.widths.filter(width => width.id !== '240'), settle_ms: 400, rules }));
  return file;
}

async function critique(url, folder) {
  const child = spawn(process.execPath, [critic, '--url', url, '--out', folder, '--rules', rulesFor(folder)], { env: { ...process.env, BROWSER_EXECUTABLE: chromium.executablePath() } });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const status = await new Promise(done => child.on('close', done));
  assert.equal(status, 0, stderr);
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

const ours = (report, rule, width = '1280') => report.findings.filter(item => item.rule === rule && item.width === width);

test('each new rule is a data row with its own thresholds, words and patterns', () => {
  for (const id of NEW_RULES) {
    const rule = craft.rules.find(row => row.id === id);
    assert.ok(rule, `${id} has a row`);
    assert.ok(rule.says && (rule.widths?.length || id === 'repeated_supporting_text'), `${id} says what is wrong and names its widths or applies at every width`);
  }
  const rule = id => craft.rules.find(row => row.id === id);
  assert.ok(rule('test_data').patterns.length >= 10, 'the test-data words and ids are data');
  assert.ok(rule('tiny_images').min_fraction > 0 && rule('tiny_images').max_downscale > 0 && rule('tiny_images').max_upscale > 1);
  assert.ok(rule('duplicate_cards').min_similarity > 0 && rule('duplicate_cards').normalize_away.length);
  assert.ok(rule('stale_demo').demo_url_patterns.some(source => /live\\\.gettrillion\\\.ai/.test(source)), 'the live demo address is data');
});

test('a page with planted defects is flagged by every new rule, each saying what and where', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'page-critic-planted-'));
  const site = await serve();
  try {
    const report = await critique(`${site.base}/planted`, folder);
    const said = (rule, pattern) => ours(report, rule).find(item => pattern.test(item.says));

    const repeated = said('repeated_supporting_text', /^The repeated heading /);
    assert.match(repeated?.selector ?? '', /p#repeated-heading$/);
    for (const width of ['390', '1280']) assert.equal(ours(report, 'repeated_supporting_text', width).length, 1);

    const hash = said('test_data', /edition hash/);
    assert.ok(hash, 'the edition hash is flagged');
    assert.match(hash.says, /93e28e69118e/);
    assert.match(hash.selector, /^main > ul\.feed > li:nth-of-type\(1\) > h3$/);
    assert.ok(said('test_data', /real-screenshots disclaimer/), 'the "real product screenshots" line is flagged');
    const inFrame = said('test_data', /example\.com address/);
    assert.ok(inFrame, 'placeholder data inside an embedded frame of another origin is flagged');
    assert.match(inFrame.selector, /^iframe#demo-error >> /);
    assert.ok(ours(report, 'test_data', '390').length, 'and on a phone');

    const small = said('tiny_images', /only 240px wide in a 600px-wide space \(40%\)/);
    assert.ok(small, JSON.stringify(ours(report, 'tiny_images')));
    assert.match(small.selector, /img#shot$/);
    assert.ok(said('tiny_images', /shrunk 5\.0 times \(from 1200px to 240px\), so its text is about 2\.8px/), 'the screenshot is shrunk past reading');
    const stretched = said('tiny_images', /stretched to 250% of its own 160px width/);
    assert.ok(stretched && /img#stretched$/.test(stretched.selector), 'the stretched picture is flagged');

    const duplicate = said('duplicate_cards', /2 cards or list items .* titled "Field Notes reflection edition [0-9a-f]{12}"/);
    assert.ok(duplicate, JSON.stringify(ours(report, 'duplicate_cards')));
    assert.match(duplicate.selector, /ul\.feed > li:nth-of-type\(2\)$/);
    const inDemo = said('duplicate_cards', /titled "Daily review"/);
    assert.ok(inDemo && /iframe#demo-error >> .*li:nth-of-type\(2\)$/.test(inDemo.selector), 'cards that repeat inside a frame are flagged');
    assert.equal(ours(report, 'duplicate_cards').filter(item => /Weekly review/.test(item.says)).length, 0, 'a unique card is not');

    const demos = JSON.stringify(ours(report, 'stale_demo').map(item => item.says));
    assert.match(said('stale_demo', /iframe#demo-down/)?.says ?? '', /did not load/, demos);
    assert.match(said('stale_demo', /iframe#demo-missing/)?.says ?? '', /did not load: answered 404/, demos);
    const error = said('stale_demo', /iframe#demo-error/);
    assert.match(error?.says ?? '', /shows an error: ".*not saved.*"/i, demos);
    assert.match(said('stale_demo', /iframe#demo-empty/)?.says ?? '', /still empty after 3 seconds/, demos);
    const clip = said('stale_demo', /clip missing-clip\.mp4 at video#clip does not load/);
    assert.ok(clip, 'the looping clip that never loads is flagged');
    assert.equal(ours(report, 'stale_demo').filter(item => /demo-ok/.test(item.says)).length, 0);

    // Each finding appears in the pictures exactly like the older rules': a marked picture of the width, and a box.
    for (const item of report.findings.filter(finding => NEW_RULES.includes(finding.rule))) {
      assert.ok(item.picture && existsSync(join(folder, item.picture)), `${item.rule} has its picture`);
      assert.ok(item.rect?.width > 0 && item.selector, `${item.rule} says where`);
    }
    for (const width of ['390', '1280']) assert.ok(report.pictures.find(item => item.width === width).findings > 0);
  } finally { site.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('a clean page of the same shape stays quiet under all four rules', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'page-critic-clean-'));
  const site = await serve();
  try {
    const report = await critique(`${site.base}/clean`, folder);
    assert.deepEqual(report.findings.filter(item => NEW_RULES.includes(item.rule)).map(item => `${item.width} ${item.rule}: ${item.says}`), []);
    assert.equal(report.pictures.length, 2);
  } finally { site.close(); rmSync(folder, { recursive: true, force: true }); }
});
