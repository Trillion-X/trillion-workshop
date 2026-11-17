// Send to Trillion's "More from this page": a Workshop tool row run on the page the person is on
// (extension/src/page-tools.mjs over extension/page-tools.json), what it hands to the tray, and the recording format a
// browser picks from the DATA list. A run is the door's Workshop operation (run_resource_operation at @tools,
// tools:run), answered with the Workshop receipt { exit_code, replayed, tool, result } around the tool's own answer; the
// tool answers inside `result` are the shapes the live account returned on 2026-09-30 for tool:read-public-web-page and
// tool:record-a-web-demo. The older task view (state, output, task_id) is still read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fillInput, keptFiles, recordingFormat, runPageTool } from '../src/page-tools.mjs';
import { createTrayClient, handleTrayMutation, sameItem, visibleToAccount } from '../src/tray.mjs';
import pageTools from '../page-tools.json' with { type: 'json' };

const row = id => pageTools.tools.find(tool => tool.id === id);
const page = { url: 'https://example.com/', title: 'Example Domain' };
const receipt = (tool, result, extra = {}) => ({ exit_code: 0, replayed: false, tool, result, ...extra });
const name = (title, extension) => `/Sent to Trillion/2026-09-30 04.00 ${title}.${extension}`;

function caller(answers) {
  const calls = [];
  return { calls, call: async (tool, args) => { calls.push({ tool, args }); return answers[tool](args); } };
}

test('a row fills each { from } with the page fact and keeps every other value as written', () => {
  const input = fillInput(row('record-page').input, { page_url: page.url });
  assert.equal(input.url, page.url);
  assert.deepEqual(input.steps, row('record-page').input.steps);
  assert.deepEqual(fillInput({ a: [{ from: 'x' }, { from: 'x', also: 1 }] }, { x: 2 }), { a: [2, { from: 'x', also: 1 }] });
});

test('reading the whole page keeps the answer as one file and hands it to the tray', async () => {
  const output = { url: page.url, final_url: page.url, status: 200, title: 'Example Domain', text: 'This domain is for use…', links: ['https://iana.org/help/example-domains'] };
  const { calls, call } = caller({
    run_resource_operation: () => receipt('tool:read-public-web-page', output),
    write_file: args => ({ identity: `1f:${'a'.repeat(64)}`, name: args.name, byte_length: args.text.length, media_type: args.media_type }),
  });
  const done = await runPageTool({ row: row('whole-page'), page, call, name, requestKey: 'stable-page-request' });
  assert.equal(calls[0].tool, 'run_resource_operation');
  assert.equal(calls[0].args.address, '@tools');
  assert.equal(calls[0].args.method, 'tools:run');
  assert.equal(calls[0].args.request_key, 'stable-page-request');
  assert.deepEqual(calls[0].args.input, { tool: 'tool:read-public-web-page', input: { url: page.url } });
  assert.deepEqual(JSON.parse(calls[1].args.text), output);
  assert.equal(calls[1].args.media_type, 'application/json');
  assert.equal(calls[1].args.request_key, undefined, 'write_file uses the stable name and content identity, not an undeclared request key');
  assert.deepEqual(done, { state: 'done', items: [{ kind: 'page-text', file: `1f:${'a'.repeat(64)}`, name: name('Example Domain', 'json'), url: page.url, title: 'Example Domain', size: calls[1].args.text.length }] });
});

test('a run that keeps its own files hands each to the tray by identity, kind from its media type', async () => {
  const video = { identity: `1f:${'b'.repeat(64)}`, bytes: 90945, media_type: 'video/mp4', name: '/Made by tools/Record a demo of a web page/2026-09-30 04.04.39/demo.mp4' };
  const gif = { identity: `1f:${'c'.repeat(64)}`, bytes: 92333, media_type: 'image/gif', name: '/Made by tools/Record a demo of a web page/2026-09-30 04.04.39/demo.gif' };
  const picture = { identity: `1f:${'d'.repeat(64)}`, bytes: 1, media_type: 'application/octet-stream', name: 'cover.png' };
  const { calls, call } = caller({ run_resource_operation: () => receipt('tool:record-a-web-demo', { result: { frames: 205 }, files: { video, gif, pictures: [picture] } }) });
  const done = await runPageTool({ row: row('record-page'), page, call, name });
  assert.equal(calls.length, 1);
  assert.deepEqual(done.items.map(item => [item.kind, item.file, item.size]), [['video', video.identity, 90945], ['image', gif.identity, 92333], ['application', picture.identity, 1]]);
  assert.deepEqual(keptFiles({ files: { none: null, broken: { name: 'x' } } }), []);
});

test('an older account\'s task view is still read: completed, still working, failed', async () => {
  const output = { title: 'Example Domain', files: { video: { identity: `1f:${'e'.repeat(64)}`, bytes: 3, media_type: 'video/mp4', name: 'demo.mp4' } } };
  assert.equal((await runPageTool({ row: row('record-page'), page, name, call: caller({ run_resource_operation: () => ({ state: 'completed', output }) }).call })).items[0].kind, 'video');
  const { call } = caller({ run_resource_operation: () => ({ task_id: 'task_7', state: 'working' }) });
  assert.deepEqual(await runPageTool({ row: row('record-page'), page, call, name }), { state: 'later', task_id: 'task_7' });
  await assert.rejects(runPageTool({ row: row('whole-page'), page, name, call: caller({ run_resource_operation: () => ({ state: 'failed', error: 'That address is not a public page.' }) }).call }),
    error => error.name === 'PageToolFailed' && /not a public page/.test(error.message));
});

test('a tool that stops is said in its own words and is not retried as a transport failure', async () => {
  const { call } = caller({ run_resource_operation: () => receipt('tool:read-public-web-page', { said: 'That address is not a public page.' }, { exit_code: 1 }) });
  await assert.rejects(runPageTool({ row: row('whole-page'), page, call, name }), error => error.name === 'PageToolFailed' && /not a public page/.test(error.message));
});

test('a receipt for another tool, or an answer in neither shape, is refused so the run can be retried with its key', async () => {
  for (const answer of [receipt('tool:something-else', { title: 'x' }), receipt('tool:read-public-web-page', null), {}, null]) {
    await assert.rejects(runPageTool({ row: row('whole-page'), page, name, call: caller({ run_resource_operation: () => answer }).call }),
      error => error.name !== 'PageToolFailed' && /complete Workshop tool run/.test(error.message));
  }
});

test('overlapping page-tool starts are admitted once per account, tool and page, and retries keep their request key', async () => {
  const source = (await readFile(new URL('../src/page-tool-runs.mjs', import.meta.url), 'utf8'))
    .split('\n').filter(line => !line.startsWith('import ')).join('\n');
  let listener;
  let stored = [];
  let account = 'account-a';
  let failNext = false;
  let switchDuringResult = false;
  let switchDuringTray = false;
  const dispatched = [];
  const trayItems = [];
  const context = vm.createContext({
    pageTools,
    crypto: { randomUUID: (() => { let id = 0; return () => `run-${++id}`; })() },
    chrome: {
      storage: { session: { get: async () => ({ page_runs: structuredClone(stored) }), set: async value => { stored = structuredClone(value.page_runs); } } },
      runtime: { onMessage: { addListener: fn => { listener = fn; } } },
    },
    signedInAccount: async () => account,
    sentFileName: () => 'unused.json',
    keepAwake: () => () => {},
    addToTrayOwned: async item => { if (switchDuringTray) { switchDuringTray = false; account = 'account-f'; await Promise.resolve(); } trayItems.push(item); },
    tool: async (_name, args) => { dispatched.push(args); return new Promise(() => {}); },
    runPageTool: async ({ row, requestKey }) => {
      dispatched.push({ row_id: row.id, request_key: requestKey });
      if (failNext) { failNext = false; throw Object.assign(new Error('temporary failure'), { name: 'Unreachable' }); }
      if (switchDuringResult) { switchDuringResult = false; account = 'account-d'; return { state: 'done', items: [{ kind: 'file', url: page.url, file: 'account-a-file' }] }; }
      if (switchDuringTray) return { state: 'done', items: [{ kind: 'file', url: page.url, file: 'account-a-file' }] };
      return new Promise(() => {});
    },
  });
  vm.runInContext(source, context);
  await Promise.resolve(); // allow the startup recovery read to finish
  const start = row_id => new Promise(resolve => {
    assert.equal(listener({ page_run: { start: { row_id, page } } }, {}, resolve), true);
  });

  const [sameA, sameB] = await Promise.all([start('whole-page'), start('whole-page')]);
  assert.equal(sameA.id, sameB.id);
  assert.equal(dispatched.filter(call => call.row_id === 'whole-page').length, 1);
  assert.equal(stored.length, 1);

  failNext = true;
  await start('record-page');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(stored.length, 2, 'a different tool keeps its own visible working row');
  assert.equal(stored.find(run => run.row_id === 'record-page').state, 'failed');
  const originalKey = stored.find(run => run.row_id === 'record-page').request_key;
  await start('record-page');
  assert.equal(stored.find(run => run.row_id === 'record-page').request_key, originalKey, 'retry reuses the idempotency key');
  assert.equal(dispatched.filter(call => call.row_id === 'record-page').length, 2);

  // A separate account gets a distinct claim and request key for the same page and tool.
  account = 'account-b';
  await start('whole-page');
  assert.equal(stored.length, 3);
  assert.equal(new Set(stored.map(run => run.request_key)).size, 3);
  assert.deepEqual(stored.map(run => run.account).sort(), ['account-a', 'account-a', 'account-b']);

  account = 'account-c'; switchDuringResult = true;
  await start('whole-page');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(trayItems.length, 0, 'a result is not placed in the tray after sign-in changes');
  assert.equal(stored.find(run => run.account === 'account-c').state, 'failed');

  account = 'account-e'; switchDuringTray = true;
  await start('record-page');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(trayItems[0].account, 'account-e', 'the tray keeps the originating account even if sign-in changes during its awaited write');
  assert.equal(visibleToAccount(trayItems[0], account), false);
});

test('worker recovery replays saved request identities and concurrent completions retain each list update', async () => {
  const source = (await readFile(new URL('../src/page-tool-runs.mjs', import.meta.url), 'utf8'))
    .split('\n').filter(line => !line.startsWith('import ')).join('\n');
  const stored = [
    { id: 'saved-1', request_key: 'saved-request-1', account: 'account-a', row_id: 'whole-page', page, state: 'working' },
    { id: 'saved-2', request_key: 'saved-request-2', account: 'account-a', row_id: 'record-page', page, state: 'working' },
    { id: 'legacy', account: 'account-a', row_id: 'whole-page', page, state: 'working' },
    { id: 'other-account', request_key: 'other-request', account: 'account-b', row_id: 'whole-page', page, state: 'working' },
  ];
  let listener;
  let account = 'account-a';
  const replayed = [];
  const completions = [];
  const context = vm.createContext({
    pageTools,
    crypto: { randomUUID: () => 'unused' },
    chrome: {
      storage: { session: { get: async () => ({ page_runs: JSON.parse(JSON.stringify(stored)) }), set: async value => { stored.splice(0, stored.length, ...JSON.parse(JSON.stringify(value.page_runs))); } } },
      runtime: { onMessage: { addListener: fn => { listener = fn; } } },
    },
    signedInAccount: async () => account,
    sentFileName: () => 'unused.json',
    keepAwake: () => () => {},
    addToTrayOwned: async () => {},
    tool: async () => ({}),
    runPageTool: ({ row, requestKey }) => {
      replayed.push([row.id, requestKey]);
      return new Promise(resolve => completions.push(resolve));
    },
  });
  vm.runInContext(source, context);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(replayed.sort((a, b) => a[0].localeCompare(b[0])), [['record-page', 'saved-request-2'], ['whole-page', 'saved-request-1']]);
  completions.forEach(resolve => resolve({ state: 'done', items: [] }));
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(stored.map(run => run.id), ['legacy', 'other-account'], 'both completed rows are removed without replaying legacy or another account\'s claim');
});

test('a recording uses the first format the browser makes, in the DATA order', () => {
  const formats = pageTools.recordings.find(item => item.id === 'tab').media_types;
  assert.equal(recordingFormat(formats, type => type.startsWith('video/webm')).extension, 'webm');
  assert.equal(recordingFormat(formats, () => true).media_type, formats[0].media_type);
  assert.equal(recordingFormat(formats, () => false), null);
  const voice = pageTools.recordings.find(item => item.id === 'audio').media_types;
  assert.equal(recordingFormat(voice, type => type === 'audio/mp4').extension, 'm4a');
});

test('what a recording captures is its row\'s DATA, with the granted stream where the row names it', () => {
  const tab = pageTools.recordings.find(item => item.id === 'tab');
  const capture = fillInput(tab.capture, { stream_id: 'stream-9' });
  assert.equal(capture.audio.mandatory.chromeMediaSourceId, 'stream-9');
  assert.equal(capture.video.mandatory.chromeMediaSourceId, 'stream-9');
  assert.equal(capture.video.mandatory.maxWidth, 1920);
  const audio = pageTools.recordings.find(item => item.id === 'audio');
  assert.deepEqual(fillInput(audio.capture, { stream_id: null }), audio.capture);
  assert.equal(audio.plays_back, false, 'a microphone is never played back to the person');
  assert.equal(tab.plays_back, true, 'a captured tab keeps its sound for the person');
  for (const row of pageTools.recordings) assert.ok(['tab', 'microphone'].includes(row.grant), `${row.id} names a grant the popup has`);
});

test('every capture row says what its kept file is, so the Sending list can name it', () => {
  for (const row of [...pageTools.tools, ...pageTools.recordings]) assert.ok(row.kept_detail && row.label && row.icon, row.id);
  assert.equal(new Set([...pageTools.tools, ...pageTools.recordings].map(row => row.id)).size, pageTools.tools.length + pageTools.recordings.length, 'row ids are unique across both lists');
});

test('the tray keeps one of the same thing and tells two kept files apart', () => {
  const a = { kind: 'video', url: page.url, file: '1f:a' };
  assert.equal(sameItem(a, { ...a }), true);
  assert.equal(sameItem(a, { ...a, file: '1f:b' }), false);
  assert.equal(sameItem({ ...a, account: 'account-a' }, { ...a, account: 'account-b' }), false);
  assert.equal(visibleToAccount({ ...a, account: 'account-a' }, 'account-b'), false);
  assert.equal(visibleToAccount(a, 'account-b'), true, 'items without account ownership stay available on the device');
  assert.equal(sameItem({ kind: 'page', url: page.url }, { kind: 'page', url: page.url }), true);
});

test('removing one account\'s page result preserves other accounts\' tray rows', async () => {
  const previous = globalThis.chrome;
  let tray = [{ kind: 'page', url: page.url }];
  globalThis.chrome = { storage: { session: {
    get: async () => { await new Promise(resolve => setTimeout(resolve, 0)); return { tray: structuredClone(tray) }; },
    set: async value => { await new Promise(resolve => setTimeout(resolve, 0)); tray = structuredClone(value.tray); },
  } } };
  try {
    // Popup and attach are separate extension documents with independent clients. Both route to the one
    // background mutation handler, so delayed storage reads cannot overwrite each other's additions.
    const popup = createTrayClient(async message => ({ tray: await handleTrayMutation(message.trillion_tray) }));
    const attach = createTrayClient(async message => ({ tray: await handleTrayMutation(message.trillion_tray) }));
    await Promise.all([
      popup.addToTray({ kind: 'file', url: page.url, file: 'same-file', account: 'account-a' }),
      attach.addToTray({ kind: 'file', url: page.url, file: 'same-file', account: 'account-b' }),
    ]);
    assert.equal(tray.length, 3, 'both contexts keep their account-specific addition and the shared item');
    await popup.removeFromTray({ kind: 'file', url: page.url, file: 'same-file', account: 'account-a' }, 'account-a');
    assert.deepEqual(tray.map(({ added_at: _addedAt, ...item }) => item), [
      { kind: 'page', url: page.url },
      { kind: 'file', url: page.url, file: 'same-file', account: 'account-b' },
    ]);
    assert.match(tray[1].added_at, /^\d{4}-\d\d-\d\dT/);
  } finally {
    if (previous === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous;
  }
});
