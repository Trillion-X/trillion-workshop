// test/screen-driving-adoption.test.mjs
//
// What the findings from a screen-pointing assistant, an AI browser and a launcher added to the screen driver (read-data/drive-the-screen.mjs, screen-driver.swift):
// a guidance-only `point` action and a visible caption before each action (F-0404, F-0411), keys posted straight to a
// background app (F-0403), the person's corner failsafe (F-0407), Secure Input named when it may have eaten the keys
// (F-0350), and a refusal that says whether the same call may be tried again (F-0594). The last tests run the REAL native
// program; none of them posts an input event to the Mac.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScreenDriver, runScreenTool, screenSettings } from '../read-data/drive-the-screen.mjs';
import { run } from '../read-data/observe-visual.mjs';

const open = screenSettings();
const DISPLAY = { index: 0, main: true, x: 0, y: 0, width: 1000, height: 500, scale: 2 };
const PROBE = { name: 'Probe', bundle_id: 'test.probe', pid: 4242 };
const rows = [
  { path: [0], depth: 1, role: 'AXWindow', title: 'Probe', frame: { x: 100, y: 100, width: 400, height: 300 } },
  { path: [0, 0], depth: 2, role: 'AXButton', title: 'Confirm Order', enabled: true, actions: ['AXPress'], frame: { x: 120, y: 120, width: 100, height: 30 } },
];
const acts = [];
function pretend({ secure, trusted = true, frontmost = PROBE } = {}) {
  acts.length = 0;
  return async request => {
    if (request.command === 'read') return { readiness: { ax_trusted: trusted, screen_capture: true }, displays: [DISPLAY], frontmost, app: PROBE, elements: request.max_nodes === 0 ? [] : rows, truncated: false };
    acts.push(request);
    return { events: request.events.map(event => ({ event: event.event, ok: true, detail: '' })), completed: true, ...(secure ? { secure_input: secure } : {}) };
  };
}
const driverOf = (program, settings = open) => makeScreenDriver({ settings, program, capture: async () => Buffer.from('x'), ocr: async () => ({ width: 2000, height: 1000, lines: [] }), wait: async () => {} });

test('point shows where a thing is and does nothing else: one caption event, no key, click or change', async () => {
  const driver = driverOf(pretend());
  const answer = await driver.drive({ action: 'point', target: 'Confirm Order' });
  assert.equal(answer.dispatched, true);
  assert.deepEqual(acts[0].events, [{ event: 'caption', x: 170, y: 135, text: 'Confirm Order', ms: open.limits.caption_ms }]);
  assert.equal(answer.verified, null);
  assert.ok(driver.actions().actions.some(row => row.id === 'point'));
});

test('narration is a flippable DATA row: off by default, and when on every located action is preceded by a caption at its point', async () => {
  assert.equal(open.narration.each_action, false);
  await driverOf(pretend()).drive({ action: 'click', target: 'Confirm Order' });
  assert.equal(acts[0].events[0].event, 'mouse_move');
  const on = { ...structuredClone(open), narration: { ...open.narration, each_action: true } };
  await driverOf(pretend(), on).drive({ action: 'click', target: 'Confirm Order' });
  assert.deepEqual(acts[0].events[0], { event: 'caption', x: 170, y: 135, text: 'click: Confirm Order', ms: open.limits.caption_ms });
  assert.equal(acts[0].events[1].event, 'mouse_move');
  await driverOf(pretend(), on).drive({ action: 'point', target: 'Confirm Order' });
  assert.equal(acts[0].events.filter(event => event.event === 'caption').length, 1, 'point is not captioned twice');
});

test('key_in_app and type_in_app post to the driven process and need no foreground; the failsafe is carried to the program', async () => {
  const away = driverOf(pretend({ frontmost: { name: 'Elsewhere', bundle_id: 'other', pid: 1 } }));
  await away.drive({ action: 'type_in_app', text: 'hello' });
  assert.deepEqual(acts.at(-1).events, [{ event: 'text', deliver: 'app', text: 'hello' }]);
  await away.drive({ action: 'key_in_app', keys: 'cmd+s' });
  assert.deepEqual(acts.at(-1).events, [{ event: 'chord', deliver: 'app', keys: [1], modifiers: ['command'] }]);
  assert.equal(acts.at(-1).pid, PROBE.pid);
  assert.deepEqual(acts.at(-1).failsafe, open.failsafe);
  assert.equal(open.failsafe.corner_px, 0, 'the stop is the person\'s to turn on');
});

test('Secure Input is named in the answer when keys were typed while it was on, and said nothing about otherwise', async () => {
  const held = await driverOf(pretend({ secure: { enabled: true, app: { name: 'Terminal', pid: 9 } } })).drive({ action: 'type', text: 'x' });
  assert.match(held.said, /Secure Input is on \(held by Terminal\)/);
  const unnamed = await driverOf(pretend({ secure: { enabled: true } })).drive({ action: 'type', text: 'x' });
  assert.match(unnamed.said, /Secure Input is on, so/);
  const quiet = await driverOf(pretend({ secure: { enabled: false } })).drive({ action: 'type', text: 'x' });
  assert.doesNotMatch(quiet.said, /Secure Input/);
});

test('a refusal says whether the same call may be tried again, and the Mac host passes it on', async () => {
  const driver = driverOf(pretend());
  const retryOf = async promise => promise.then(() => { throw new Error('expected a refusal'); }, error => error.retry);
  assert.equal(await retryOf(driver.drive({ action: 'press', target: 'Nothing like this' })), false, 'no match: a retry is the same call');
  assert.equal(await retryOf(driver.drive({ action: 'nope' })), false);
  assert.equal(await retryOf(driver.look({ consent: true })), false, 'carried consent is a no');
  assert.equal(await retryOf(driverOf(pretend({ trusted: false })).look()), false, 'a Mac permission waits for the person');
  const failing = driverOf(async () => { throw new Error('timed out'); });
  assert.equal(await retryOf(failing.look()), true, 'a program that did not answer may answer next time');
  const answer = await runScreenTool('look', { consent: true });
  assert.equal(answer.retry, false);
  assert.match(answer.error, /never carried by a call/);
});

test('the real native program reports Secure Input beside the readiness, and a failsafe stops a run before any event is posted', { skip: process.platform !== 'darwin' }, async () => {
  const swift = new URL('../read-data/screen-driver.swift', import.meta.url).pathname;
  const read = JSON.parse(await run('/usr/bin/swift', [swift], { input: JSON.stringify({ command: 'read', max_nodes: 0 }), timeout: 60_000 }));
  assert.equal(typeof read.secure_input.enabled, 'boolean');
  const stopped = JSON.parse(await run('/usr/bin/swift', [swift], {
    input: JSON.stringify({ command: 'act', pid: process.pid, failsafe: { corner_px: 1e9 }, events: [{ event: 'mouse_move', deliver: 'app', x: 5, y: 5 }] }), timeout: 60_000 }));
  assert.equal(stopped.completed, false);
  assert.equal(stopped.events[0].code, 'failsafe');
  const gone = JSON.parse(await run('/usr/bin/swift', [swift], {
    input: JSON.stringify({ command: 'act', pid: 2147483647, events: [{ event: 'chord', deliver: 'app', keys: [1], modifiers: ['command'] }] }), timeout: 60_000 }));
  assert.equal(gone.completed, false);
  assert.match(gone.events[0].detail, /no longer running/);
});

test('the real native program shows a caption window that takes no focus and ends', { skip: process.platform !== 'darwin' }, async () => {
  const swift = new URL('../read-data/screen-driver.swift', import.meta.url).pathname;
  const shown = JSON.parse(await run('/usr/bin/swift', [swift], {
    input: JSON.stringify({ command: 'act', pid: process.pid, events: [{ event: 'caption', x: 300, y: 300, text: 'Trillion screen-driving test', ms: 300 }] }), timeout: 60_000 }));
  assert.equal(shown.completed, true);
  assert.deepEqual(shown.events, [{ event: 'caption', ok: true, detail: '' }]);
  assert.equal(shown.secure_input, undefined, 'a caption types nothing');
});

test('a rehearsal returns the proposed plan as plain sentences, one per event, read from DATA, and dispatches nothing (F-0561)', async () => {
  const driver = driverOf(pretend());
  const answer = await driver.drive({ action: 'click', target: 'Confirm Order', dry_run: true });
  assert.equal(answer.dispatched, false);
  assert.equal(acts.length, 0);
  assert.deepEqual(answer.plan, ['Move the pointer to (170, 135).', 'Press the left mouse button (down) at (170, 135).', 'Wait 35 ms.', 'Press the left mouse button (up) at (170, 135).']);
  const keys = await driver.drive({ action: 'key_in_app', keys: 'cmd+s', dry_run: true });
  assert.deepEqual(keys.plan, ['Press the key combination command + 1.']);
  const typed = await driver.drive({ action: 'type_in_app', text: 'hello', dry_run: true });
  assert.deepEqual(typed.plan, ['Type: hello']);
  const row = structuredClone(open);
  row.actions.shrug = { what: 'x', steps: [{ event: 'shrug_event' }] };
  assert.deepEqual((await driverOf(pretend(), row).drive({ action: 'shrug', dry_run: true })).plan, ['Run the shrug_event step.']);
});
