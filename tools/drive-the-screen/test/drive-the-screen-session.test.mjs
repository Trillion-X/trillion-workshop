// test/drive-the-screen-session.test.mjs
// The screen driver and the session it acts in (F-0188, F-0239, F-0206): a locked screen waits for the person and is
// never unlocked, a host the app no longer owns refuses with a typed state, the person's stop key ends a drive, and the
// real Swift program reports what it watches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { makeScreenDriver, screenSettings } from '../read-data/drive-the-screen.mjs';

const DISPLAY = { index: 0, main: true, x: 0, y: 0, width: 1000, height: 500, scale: 2 };
const APP = { name: 'Probe', bundle_id: 'test.probe', pid: 7 };
const elements = [{ path: [0, 0], depth: 2, role: 'AXButton', title: 'Go', enabled: true, actions: ['AXPress'], frame: { x: 10, y: 10, width: 50, height: 20 } }];

function mac({ locked = false, act = null } = {}) {
  const seen = [];
  const program = async request => {
    seen.push(request);
    if (request.command === 'read') return { readiness: { ax_trusted: true, screen_capture: true, screen_locked: locked }, displays: [DISPLAY], frontmost: APP, app: APP, elements: request.max_nodes === 0 ? [] : elements, truncated: false };
    return act ? act(request) : { events: request.events.map(event => ({ event: event.event, ok: true, detail: '' })), completed: true };
  };
  return { seen, program };
}
const driverOn = (m, extra = {}) => makeScreenDriver({ settings: screenSettings(), home: '/nonexistent', program: m.program, capture: async () => Buffer.from('p'),
  ocr: async () => ({ width: 2000, height: 1000, lines: [] }), wait: async () => {}, parent: () => 4242, ...extra });

test('a locked screen is a typed ask_user refusal, nothing is dispatched and nothing unlocks it', async () => {
  const m = mac({ locked: true });
  await assert.rejects(driverOn(m).drive({ action: 'press', target: 'Go' }), error => {
    assert.equal(error.reaction, 'ask_user');
    assert.match(error.message, /screen is locked.*never unlocks/s);
    console.log('readback locked:', error.message);
    return true;
  });
  assert.equal(m.seen.some(request => request.command === 'act'), false);
});

test('a host whose parent is launchd refuses with its own state; switched off in DATA it does not', async () => {
  await assert.rejects(driverOn(mac(), { parent: () => 1 }).look({}), error => { assert.equal(error.reaction, 'ask_user'); assert.match(error.message, /run under the system/); console.log('readback launchd:', error.message); return true; });
  const settings = screenSettings();
  settings.acting.refuse_under_launchd = false;
  const open = makeScreenDriver({ settings, home: '/nonexistent', program: mac().program, capture: async () => Buffer.from('p'), ocr: async () => ({ width: 2000, height: 1000, lines: [] }), wait: async () => {}, parent: () => 1 });
  assert.ok((await open.look({})).app);
});

test('the driver is told the stop key; a drive the person stopped says stop and that steps may have run', async () => {
  const m = mac({ act: () => ({ events: [{ event: 'pause', ok: true, detail: '' }, { event: 'chord', ok: false, detail: 'The person pressed the stop key.' }], completed: false, stopped_by_person: true }) });
  await assert.rejects(driverOn(m).drive({ action: 'press', target: 'Go' }), error => {
    assert.equal(error.reaction, 'stop'); assert.equal(error.outcome, 'unknown'); assert.match(error.message, /stop key/);
    return true;
  });
  const act = m.seen.find(request => request.command === 'act');
  assert.deepEqual(act.stop, { enabled: true, key_code: 53, marker: 7210 });
});

test('the real Swift program reports the lock state, watches the stop key and puts back what it un-hid', { skip: process.platform !== 'darwin' }, () => {
  const run = request => JSON.parse(execFileSync('/usr/bin/swift', [new URL('../read-data/screen-driver.swift', import.meta.url).pathname], { input: JSON.stringify(request), stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf8' }));
  const read = run({ command: 'read', max_nodes: 0 });
  assert.equal(typeof read.readiness.screen_locked, 'boolean');
  const acted = run({ command: 'act', pid: 99999, events: [{ event: 'pause', ms: 1 }], stop: { enabled: true, key_code: 53, marker: 7210 } });
  assert.equal(acted.completed, true);
  assert.deepEqual(acted.rehidden, []);
  assert.deepEqual(acted.released, [], 'a run that pressed nothing lets go of nothing');
  console.log('readback real driver:', JSON.stringify({ readiness: read.readiness, stop_key_watched: acted.stop_key_watched }));
  const source = readFileSync(new URL('../read-data/screen-driver.swift', import.meta.url), 'utf8');
  assert.match(source, /setIntegerValueField\(\.eventSourceUserData, value: stopMarker\)/, 'every posted event carries the marker');
});

test('a button the drive still held when it ended was let go, and the answer says so, ended early or not', async () => {
  const stopped = mac({ act: () => ({ events: [{ event: 'mouse_button', ok: true, detail: '' }, { event: 'mouse_move', ok: false, detail: 'The person pressed the stop key.' }], completed: false, stopped_by_person: true, released: ['left'] }) });
  await assert.rejects(driverOn(stopped).drive({ action: 'press', target: 'Go' }), error => {
    assert.equal(error.reaction, 'stop');
    assert.match(error.message, /The left mouse button the drive still held when it ended was let go/);
    return true;
  });
  const finished = mac({ act: request => ({ events: request.events.map(event => ({ event: event.event, ok: true, detail: '' })), completed: true, released: ['left'] }) });
  const answer = await driverOn(finished).drive({ action: 'press', target: 'Go' });
  assert.match(answer.said, /The left mouse button the drive still held when it ended was let go/);
  const source = readFileSync(new URL('../read-data/screen-driver.swift', import.meta.url), 'utf8');
  assert.match(source, /for \(button, at\) in pressed\.sorted/, 'the program lets go of every button it still holds before it answers');
});
