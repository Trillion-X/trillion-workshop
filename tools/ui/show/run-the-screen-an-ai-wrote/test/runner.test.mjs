// The runner in a real browser, inside a stand-in AI app that speaks MCP Apps the way Claude and ChatGPT do: the page
// in an opaque-origin frame (sandbox="allow-scripts"), the AI's arguments sent while typed and then whole, the tool's
// result, and the page's tools/call answered by a stand-in door.
import { tempFolder } from '../../../../../test-helpers/temp-folder.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const folder = tempFolder(join(tmpdir(), 'screen-runner-'));
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
  if (m.method) (window.heard ??= []).push(m);
  if (m.method === 'ui/initialize') reply({ protocolVersion: '2026-01-26', hostContext: { displayMode: 'inline', theme: 'dark', availableDisplayModes: ['inline', 'fullscreen'] } });
  if (m.method === 'ui/request-display-mode') reply({ mode: m.params.mode });
  if (m.method === 'ui/message') { if (Array.isArray(m.params?.content)) reply({}); else f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Invalid MCP message params' } }, '*'); }
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
  return { tab, frame, errors, heard: () => tab.evaluate(() => window.heard ?? []), say: (method, params) => tab.evaluate(([m, p]) => window.say(m, p), [method, params]), calls: () => tab.evaluate(() => window.calls) };
}

const words = { order: ['kept'], kept: { method: 'tools:run', input: { sql: 'select code', params: ['{for_operation}'] }, code_at: '/rows' }, mine: ['ai:chat'] };
const screen = '<h1 id="t">Three dinners</h1><button id="b">Pick</button><p id="a"></p><script>door.onAnswer(a => { document.getElementById("a").textContent = a.dinners.join(", "); }); document.getElementById("b").onclick = () => door.run("records:read", { id: "dinner:1" }).then(r => { document.getElementById("a").textContent = "picked " + r.id; });</script>';
const callArgs = { method: 'records:list', request_key: 'k', input: {} };
const RUN = 'do_one_thing_in_my_account';

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
    assert.equal(run.name, RUN);
    assert.match(run.arguments.request_key, /^[0-9a-f]{32}$/);
    assert.equal(await one.frame().evaluate(() => document.documentElement.style.colorScheme), 'dark', 'the page follows the app\'s dark theme');
    assert.deepEqual(one.errors, []);
  } finally { await browser.close(); }
});

test('a request of the page\'s own that the app refuses is said on the screen, never dropped', async () => {
  const browser = await chromium.launch();
  try {
    const keepWords = { ...words, keep: { method: 'tools:run', input: { sql: 'insert', params: ['{id}'] } } };
    const refused = await app(browser, keepWords, () => ({ isError: true, content: [{ type: 'text', text: 'The person has not allowed this.' }] }));
    await refused.say('ui/notifications/tool-input', { arguments: { ...callArgs, screen: '<p id="s">shown</p>' } });
    await refused.say('ui/notifications/tool-result', { structuredContent: {}, content: [] });
    await refused.tab.waitForTimeout(200);
    assert.equal(await refused.frame().textContent('#s'), 'shown');
    assert.match(await refused.frame().textContent('body'), /This screen was not kept: The person has not allowed this\./);
  } finally { await browser.close(); }
});

test('a run the door refuses is said on the screen and still rejects to the code, and names only its method', async () => {
  const browser = await chromium.launch();
  try {
    const refused = await app(browser, words, () => ({ isError: true, content: [{ type: 'text', text: 'No owner here answers this.' }] }));
    const code = '<button id="b">Load</button><p id="n">waiting</p><script>document.getElementById("b").onclick = () => door.run("tools:list", {}).catch(() => { document.getElementById("n").textContent = "handled"; });</script>';
    await refused.say('ui/notifications/tool-input', { arguments: { ...callArgs, screen: code } });
    await refused.tab.waitForTimeout(150);
    await refused.frame().click('#b');
    await refused.tab.waitForTimeout(150);
    assert.match(await refused.frame().textContent('body'), /This did not work: No owner here answers this\./);
    assert.equal(await refused.frame().textContent('#n'), 'handled', 'the code still hears the refusal');
    const sent = (await refused.calls()).find(call => call.arguments.method === 'tools:list');
    assert.deepEqual(Object.keys(sent.arguments).sort(), ['input', 'method', 'request_key'], 'a call names its method, never an address');
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
    assert.deepEqual((await kept.calls())[0].arguments.input.params, ['records:list'], 'asked for the screen kept for this operation');
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
      ? { structuredContent: { rows: [{ code: '<button id="b">Go</button><script>document.getElementById("b").onclick = () => door.run("x:delete", {});</script>', made_by: 'shared:someone' }] }, content: [] }
      : { structuredContent: { done: true }, content: [] });
    await shared.say('ui/notifications/tool-input', { arguments: callArgs });
    await shared.say('ui/notifications/tool-result', { structuredContent: {}, content: [] });
    await shared.tab.waitForTimeout(200);
    await shared.frame().click('#b');
    await shared.tab.waitForTimeout(100);
    assert.equal((await shared.calls()).filter(call => call.arguments.method === 'x:delete').length, 0, 'nothing ran before the press');
    assert.match(await shared.frame().textContent('body'), /wants to run x:delete/);
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

test('a show tool\'s call hands the screen the answer it carries, and the page wears the owner\'s look', async () => {
  const browser = await chromium.launch();
  try {
    const shown = await app(browser, { ...words, css: ':root{--bg-primary:rgb(1, 2, 3)}' });
    await shown.say('ui/notifications/tool-input', { arguments: { method: 'tools:list', answer: { tools: ['a', 'b'] }, screen: '<p id="n"></p><script>door.onAnswer(a => { document.getElementById("n").textContent = a.tools.length; });</script>' } });
    await shown.say('ui/notifications/tool-result', { content: [{ type: 'text', text: 'Shown to the person.' }] });
    await shown.tab.waitForTimeout(200);
    assert.equal(await shown.frame().textContent('#n'), '2', 'the answer came with the call');
    assert.equal(await shown.frame().evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(1, 2, 3)');
  } finally { await browser.close(); }
});

test('in an app that holds the call before the page starts (ChatGPT: window.openai), the screen still paints', async () => {
  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage();
    const errors = [];
    tab.on('pageerror', error => errors.push(error.message));
    const html = page(words).replace('<head>', `<head><script>window.openai = { toolInput: { method: 'tools:list', answer: { n: 2 }, screen: '<p id="n"></p><script>door.onAnswer(a => { document.getElementById("n").textContent = a.n; });<\\/script>' }, toolOutput: null };</script>`);
    const file = join(folder, 'held.html');
    writeFileSync(file, html);
    await tab.goto(`file://${file}`);
    await tab.waitForTimeout(300);
    assert.deepEqual(errors, []);
    assert.equal(await tab.textContent('#n'), '2', 'painted from what the app held before the page started');
  } finally { await browser.close(); }
});

test('a show tool\'s answer is kept when ChatGPT hands its one-line result as the output', async () => {
  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage();
    const html = page(words).replace('<head>', `<head><script>window.openai = { toolInput: { answer: { tools: ['a', 'b', 'c'] }, screen: '<p id="n"></p><script>door.onAnswer(a => { document.getElementById("n").textContent = a.tools.length; });<\\/script>' }, toolOutput: { text: 'Shown to the person.' } };</script>`);
    const file = join(folder, 'shown.html');
    writeFileSync(file, html);
    await tab.goto(`file://${file}`);
    await tab.waitForTimeout(300);
    assert.equal(await tab.textContent('#n'), '3', 'the answer the call carried, not the result\'s words');
  } finally { await browser.close(); }
});

test('a screen taller than its frame scrolls inside it, tells its whole height on each change, and offers to be seen whole', async () => {
  const browser = await chromium.launch();
  try {
    const tall = await app(browser, words);
    const rows = '<div id="rows"></div><script>const r = document.getElementById("rows"); for (let i = 0; i < 5; i++) r.insertAdjacentHTML("beforeend", "<p style=\\"height:100px;margin:0\\">row</p>"); setTimeout(() => { for (let i = 0; i < 20; i++) r.insertAdjacentHTML("beforeend", "<p style=\\"height:100px;margin:0\\">later</p>"); }, 200);</script>';
    await tall.say('ui/notifications/tool-input', { arguments: { ...callArgs, screen: rows } });
    await tall.tab.waitForTimeout(600);
    const heights = (await tall.heard()).filter(m => m.method === 'ui/notifications/size-changed').map(m => m.params.height);
    assert.ok(Math.max(...heights) >= 2500, `the whole height is told after the screen grew by itself: ${heights}`);
    const box = await tall.frame().evaluate(() => { const h = document.getElementById('screen'); return { client: h.clientHeight, scroll: h.scrollHeight }; });
    assert.ok(box.client <= 400 && box.scroll >= 2500, `the screen scrolls inside the 400px frame: ${JSON.stringify(box)}`);
    await tall.tab.evaluate(() => { document.getElementById('f').style.height = '3200px'; });
    await tall.tab.waitForTimeout(200);
    assert.equal(await tall.frame().locator('text=See all').count(), 0, 'once the frame holds all of it, the press goes');
    await tall.tab.evaluate(() => { document.getElementById('f').style.height = '400px'; });
    await tall.tab.waitForTimeout(200);
    await tall.frame().click('text=See all');
    await tall.tab.waitForTimeout(100);
    assert.ok((await tall.heard()).some(m => m.method === 'ui/request-display-mode' && m.params.mode === 'fullscreen'), 'the press asked to be shown whole');
  } finally { await browser.close(); }
});

test('a press on the screen is said in the conversation as the person, so the AI hears what was picked', async () => {
  const browser = await chromium.launch();
  try {
    const picked = await app(browser, words);
    await picked.say('ui/notifications/tool-input', { arguments: { ...callArgs, screen: '<button id="b">Find decisions</button><script>document.getElementById("b").onclick = () => door.tell("I picked: Find decisions");</script>' } });
    await picked.tab.waitForTimeout(150);
    await picked.frame().click('#b');
    await picked.tab.waitForTimeout(150);
    const told = (await picked.heard()).filter(m => m.method === 'ui/message');
    assert.deepEqual(told.map(m => m.params), [{ role: 'user', content: [{ type: 'text', text: 'I picked: Find decisions' }] }]);
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
