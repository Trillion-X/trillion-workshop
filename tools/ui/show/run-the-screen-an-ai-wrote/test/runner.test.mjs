// The runner in a real browser, inside a stand-in AI app that speaks MCP Apps the way Claude and ChatGPT do: the page
// in an opaque-origin frame (sandbox="allow-scripts"), the AI's arguments sent while typed and then whole, the tool's
// result, and the page's tools/call answered by a stand-in door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const folder = mkdtempSync(join(tmpdir(), 'screen-runner-'));
const wordsFile = join(folder, 'words.json');
const pageFile = join(folder, 'screen.html');

function page(words) {
  writeFileSync(wordsFile, JSON.stringify(words));
  execFileSync(process.execPath, [join(here, '..', 'make-screen-document.mjs'), wordsFile, pageFile]);
  return readFileSync(pageFile, 'utf8');
}

// The stand-in app: frames the page, answers its handshake, and answers each tools/call with `door(args)`.
const appHtml = `<!doctype html><body><iframe id="f" sandbox="allow-scripts" style="width:600px;height:400px"></iframe><script>
window.calls = [];
const f = document.getElementById('f');
window.addEventListener('message', async event => {
  const m = event.data; if (!m || m.jsonrpc !== '2.0') return;
  const reply = result => f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result }, '*');
  if (m.method === 'ui/initialize') reply({ protocolVersion: '2026-01-26', hostContext: { displayMode: 'inline' } });
  if (m.method === 'tools/call') { window.calls.push(m.params); reply(await window.door(m.params)); }
});
window.say = (method, params) => f.contentWindow.postMessage({ jsonrpc: '2.0', method, params }, '*');
window.load = html => new Promise(done => { f.onload = done; f.srcdoc = html; });
</script></body>`;

async function app(browser, words, door) {
  const tab = await browser.newPage();
  const errors = [];
  tab.on('pageerror', error => errors.push(error.message));
  await tab.setContent(appHtml);
  await tab.exposeFunction('doorAnswer', door ?? (() => ({ structuredContent: { ok: true }, content: [] })));
  await tab.evaluate(() => { window.door = params => window.doorAnswer(params); });
  await tab.evaluate(html => window.load(html), page(words));
  await tab.waitForTimeout(100);
  const frame = () => tab.frames().find(one => one !== tab.mainFrame());
  return { tab, frame, errors, say: (method, params) => tab.evaluate(([m, p]) => window.say(m, p), [method, params]), calls: () => tab.evaluate(() => window.calls) };
}

const words = { order: ['kept'], kept: { address: '@tools', method: 'tools:run', input: { sql: 'select code', params: ['{for_operation}'] }, code_at: '/rows' }, mine: ['ai:chat'] };
const screen = '<h1 id="t">Three dinners</h1><button id="b">Pick</button><p id="a"></p><script>door.onAnswer(a => { document.getElementById("a").textContent = a.dinners.join(", "); }); document.getElementById("b").onclick = () => door.run("@own-records", "records:read", { id: "dinner:1" }).then(r => { document.getElementById("a").textContent = "picked " + r.id; });</script>';
const callArgs = { address: '@own-records', method: 'records:list', request_key: 'k', input: {} };

test('code paints while it is typed, runs once whole, and its press runs through the door as the person', async () => {
  const browser = await chromium.launch();
  try {
    const one = await app(browser, words, params => ({ structuredContent: { id: params.arguments.input.id }, content: [] }));
    await one.say('ui/notifications/tool-input-partial', { arguments: { ...callArgs, screen: screen.slice(0, 30) } });
    await one.tab.waitForTimeout(100);
    assert.equal(await one.frame().textContent('#t'), 'Three dinners', 'the first typed bytes are already on the screen');
    await one.say('ui/notifications/tool-input', { arguments: { ...callArgs, screen } });
    await one.say('ui/notifications/tool-result', { structuredContent: { dinners: ['soup', 'rice', 'tacos'] }, content: [] });
    await one.tab.waitForTimeout(150);
    assert.equal(await one.frame().textContent('#a'), 'soup, rice, tacos', 'the script ran and heard the answer');
    await one.frame().click('#b');
    await one.tab.waitForTimeout(150);
    assert.equal(await one.frame().textContent('#a'), 'picked dinner:1', 'the press drew the door\'s answer');
    const run = (await one.calls()).find(call => call.arguments.method === 'records:read');
    assert.equal(run.name, 'run_resource_operation');
    assert.match(run.arguments.request_key, /^[0-9a-f]{32}$/);
    assert.deepEqual(one.errors, []);
  } finally { await browser.close(); }
});

test('a call with no code opens the kept screen; with none kept, the answer is text', async () => {
  const browser = await chromium.launch();
  try {
    const kept = await app(browser, words, params => params.arguments.input.sql ? { structuredContent: { rows: [{ code: '<p id="k">kept one</p>', made_by: 'ai:chat' }] }, content: [] } : { structuredContent: {}, content: [] });
    await kept.say('ui/notifications/tool-input', { arguments: callArgs });
    await kept.say('ui/notifications/tool-result', { structuredContent: { dinners: [] }, content: [{ type: 'text', text: 'no dinners' }] });
    await kept.tab.waitForTimeout(200);
    assert.equal(await kept.frame().textContent('#k'), 'kept one');
    assert.deepEqual((await kept.calls())[0].arguments.input.params, ['@own-records records:list'], 'asked for the screen kept for this operation');
    const none = await app(browser, words, () => ({ structuredContent: { rows: [] }, content: [] }));
    await none.say('ui/notifications/tool-input', { arguments: callArgs });
    await none.say('ui/notifications/tool-result', { structuredContent: { dinners: [] }, content: [{ type: 'text', text: 'no dinners' }] });
    await none.tab.waitForTimeout(200);
    assert.equal(await none.frame().textContent('#screen'), 'no dinners');
  } finally { await browser.close(); }
});

test('a screen someone else made asks before it acts, and a thrown script says so with a fix', async () => {
  const browser = await chromium.launch();
  try {
    const shared = await app(browser, words, params => params.arguments.input.sql
      ? { structuredContent: { rows: [{ code: '<button id="b">Go</button><script>document.getElementById("b").onclick = () => door.run("@x", "x:delete", {});</script>', made_by: 'shared:someone' }] }, content: [] }
      : { structuredContent: { done: true }, content: [] });
    await shared.say('ui/notifications/tool-input', { arguments: callArgs });
    await shared.say('ui/notifications/tool-result', { structuredContent: {}, content: [] });
    await shared.tab.waitForTimeout(200);
    await shared.frame().click('#b');
    await shared.tab.waitForTimeout(100);
    assert.equal((await shared.calls()).filter(call => call.arguments.method === 'x:delete').length, 0, 'nothing ran before the press');
    assert.match(await shared.frame().textContent('body'), /wants to run @x x:delete/);
    await shared.frame().click('text=Allow');
    await shared.tab.waitForTimeout(100);
    assert.equal((await shared.calls()).filter(call => call.arguments.method === 'x:delete').length, 1);
    const broken = await app(browser, words);
    await broken.say('ui/notifications/tool-input', { arguments: { ...callArgs, screen: '<script>nothere()</script>' } });
    await broken.tab.waitForTimeout(150);
    assert.match(await broken.frame().textContent('body'), /nothere is not defined/);
    assert.equal(await broken.frame().textContent('button'), 'Fix');
  } finally { await browser.close(); }
});

test('opened as a page, the answer in the address fragment is shown as text', async () => {
  const browser = await chromium.launch();
  try {
    const html = page({ ...words, fragment_answer: 'v' });
    const tab = await browser.newPage();
    const file = join(folder, 'as-page.html');
    writeFileSync(file, html);
    const answer = Buffer.from(JSON.stringify({ dinners: ['soup'] })).toString('base64url');
    await tab.goto(`file://${file}#v=${answer}`);
    await tab.waitForTimeout(200);
    assert.match(await tab.textContent('#screen'), /soup/);
  } finally { await browser.close(); }
});
