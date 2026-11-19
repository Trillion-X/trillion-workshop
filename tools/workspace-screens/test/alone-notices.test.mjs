// Proof of the notices loop of the page shown alone (web/src/workspace/alone-notices.mjs): each new notice is told once,
// the device registers once before its first read, the cursor moves only after the notices were told, a failed read keeps
// the cursor, a tap marks then acts and returns the path to open, and the host kinds equal alone-page.json host_kinds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FROM_HOST_KINDS, NOTICE_WORKFLOWS, TO_HOST_KINDS, deviceIdOf, keepNotices } from '../web/src/workspace/alone-notices.mjs';

const page = JSON.parse(readFileSync(new URL('../web/src/alone-page.json', import.meta.url), 'utf8'));
const memoryStorage = () => { const map = new Map(); return { getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => { map.set(key, String(value)); } }; };

// A fake Workshop: `answers` maps a workflow row to what it returns, or to a function that throws or answers.
function fakeRun(answers) {
  const calls = [];
  const run = async (row, input) => {
    calls.push({ row, input });
    const answer = answers[row];
    if (typeof answer === 'function') return answer(input);
    if (answer === undefined) throw new Error(`no answer for ${row}`);
    return answer;
  };
  return { run, calls };
}

// A loop that is started by the test, and stopped at its end, so no timer outlives the test.
function start({ run, storage = memoryStorage(), database = 'p_made_up', device = 'device-made-up', told = [] }) {
  const loop = keepNotices({
    database: async () => database,
    deviceId: async () => device,
    run,
    tell: message => told.push(message),
    open: path => told.push({ opened: path }),
    storage,
    settings: page.notices,
  });
  return { loop, storage, told };
}

test('the host kinds the loop sends and takes are the ones alone-page.json lists', () => {
  assert.deepEqual([...TO_HOST_KINDS].sort(), ['notify', 'register_device']);
  assert.deepEqual([...FROM_HOST_KINDS], ['notice_tapped']);
  assert.deepEqual(page.host_kinds.from_host, [...FROM_HOST_KINDS]);
  for (const kind of TO_HOST_KINDS) assert.ok(page.host_kinds.to_host.includes(kind), `${kind} is listed to_host`);
});

test('the device registers once, then each new notice is told once and the cursor moves past it', async () => {
  const notice = (id, title) => ({ id, title, body: `${title} body`, open: null, at: '2026-01-01T00:01:00.000Z', read: false });
  let answerNumber = 0;
  const { run, calls } = fakeRun({
    [NOTICE_WORKFLOWS.read]: input => {
      answerNumber += 1;
      return answerNumber === 1
        ? { device_id: input.device_id, route: 'live', cursor: 2, notices: [notice('told:1', 'One'), notice('told:2', 'Two')], said: '2 notices are ready for this device, oldest first.' }
        : { device_id: input.device_id, route: 'live', cursor: 2, notices: [], said: '0 notices are ready for this device, oldest first.' };
    },
  });
  const { loop, storage, told } = start({ run });
  await loop.readNew();
  await loop.readNew();
  loop.stop();
  assert.deepEqual(told.filter(m => m.kind === 'register_device'), [{ kind: 'register_device', device_id: 'device-made-up' }]);
  assert.deepEqual(told.filter(m => m.kind === 'notify'), [
    { kind: 'notify', id: 'told:1', title: 'One', body: 'One body' },
    { kind: 'notify', id: 'told:2', title: 'Two', body: 'Two body' },
  ]);
  assert.equal(storage.getItem('notice-cursor:device-made-up'), '2');
  assert.equal(calls[0].row, NOTICE_WORKFLOWS.read);
  assert.deepEqual(calls[0].input, { database: 'p_made_up', device_id: 'device-made-up', after: 0, limit: page.notices.limit });
  assert.equal(calls[1].input.after, 2, 'the second read starts after the cursor the first kept');
});

test('a failed read keeps the cursor and tells nothing; the next read starts where it was', async () => {
  let fail = true;
  const { run, calls } = fakeRun({
    [NOTICE_WORKFLOWS.read]: input => {
      if (fail) throw new Error('This device is not registered to read notices.');
      return { device_id: input.device_id, route: 'live', cursor: 5, notices: [{ id: 'told:5', title: 'Five', body: '', open: null, at: null, read: false }], said: '1 notice is ready for this device, oldest first.' };
    },
  });
  const { loop, storage, told } = start({ run, storage: (() => { const s = memoryStorage(); s.setItem('notice-cursor:device-made-up', '3'); return s; })() });
  await loop.readNew();
  assert.equal(storage.getItem('notice-cursor:device-made-up'), '3', 'a failed read keeps the cursor');
  assert.equal(told.filter(m => m.kind === 'notify').length, 0);
  fail = false;
  await loop.readNew();
  loop.stop();
  assert.equal(calls.at(-1).input.after, 3);
  assert.deepEqual(told.filter(m => m.kind === 'notify').map(m => m.id), ['told:5']);
  assert.equal(storage.getItem('notice-cursor:device-made-up'), '5');
});

test('nothing is read until the person and the device are known', async () => {
  const { run, calls } = fakeRun({ [NOTICE_WORKFLOWS.read]: { device_id: 'x', route: 'live', cursor: 0, notices: [], said: '' } });
  const loop = keepNotices({ database: async () => null, deviceId: async () => 'device-made-up', run, tell: () => {}, open: () => {}, storage: memoryStorage(), settings: page.notices });
  await loop.readNew();
  loop.stop();
  assert.equal(calls.length, 0);
});

test('a tap marks the notice read, then acts on its open, and the path is opened in place', async () => {
  const { run, calls } = fakeRun({
    [NOTICE_WORKFLOWS.mark]: { ids: ['told:7'], read: true, changed: true, said: '1 notice marked read.' },
    [NOTICE_WORKFLOWS.act]: { done: true, said: 'Opening the notice.', open: '/work/reports/7' },
  });
  const { loop, told } = start({ run });
  const handled = loop.host({ kind: 'notice_tapped', id: 'told:7' });
  assert.equal(handled, true);
  await new Promise(resolve => setTimeout(resolve, 20));
  loop.stop();
  assert.deepEqual(calls.map(c => c.row), [NOTICE_WORKFLOWS.mark, NOTICE_WORKFLOWS.act]);
  assert.deepEqual(calls[0].input, { database: 'p_made_up', ids: ['told:7'] });
  assert.deepEqual(calls[1].input, { database: 'p_made_up', id: 'told:7', action: 'open' });
  assert.deepEqual(told.filter(m => m.opened), [{ opened: '/work/reports/7' }]);
});

test('a tap whose action gives no path opens nothing, and a refused action keeps the page as it is', async () => {
  const { run } = fakeRun({
    [NOTICE_WORKFLOWS.mark]: { ids: ['told:2'], read: true, changed: false, said: '1 notice marked read.' },
    [NOTICE_WORKFLOWS.act]: () => { throw new Error('That action was not offered by this notice.'); },
  });
  const { loop, told } = start({ run });
  loop.host({ kind: 'notice_tapped', id: 'told:2' });
  await new Promise(resolve => setTimeout(resolve, 20));
  loop.stop();
  assert.deepEqual(told.filter(m => m.opened), []);
});

test('a host message of a kind the page does not take is not answered', async () => {
  const { run, calls } = fakeRun({});
  const { loop } = start({ run });
  assert.equal(loop.host({ kind: 'shortcut', id: 'told:1' }), false);
  assert.equal(loop.host({ kind: 'notice_tapped' }), false, 'a tap names its notice');
  assert.equal(loop.host(null), false);
  loop.stop();
  assert.equal(calls.length, 0);
});

test('the device id is made once per browser and kept', () => {
  const storage = memoryStorage();
  let made = 0;
  const first = deviceIdOf(storage, () => { made += 1; return 'device-first'; });
  const second = deviceIdOf(storage, () => { made += 1; return 'device-second'; });
  assert.equal(first, 'device-first');
  assert.equal(second, 'device-first');
  assert.equal(made, 1);
});
