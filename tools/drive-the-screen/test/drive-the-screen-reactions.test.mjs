// test/drive-the-screen-reactions.test.mjs
//
// What a refusal from the Mac's screen driver tells the AI to do (read-data/drive-the-screen.json `reactions`): retry,
// ask the person, look again, or stop; an action that stopped part-way says it may have run; the off-limits classes are
// a policy that is off until switched on; and two AIs never drive the same screen at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScreenDriver, offLimitsClass, runScreenTool, screenSettings } from '../read-data/drive-the-screen.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePlaces } from '../read-data/work-places.mjs';

const DISPLAY = { index: 0, main: true, x: 0, y: 0, width: 1000, height: 500, scale: 2 };
const APP = { name: 'Probe', bundle_id: 'test.probe', pid: 7 };

function pretendMac({ app = APP, failAct = false, actDelay = 0 } = {}) {
  const log = [];
  const program = async request => {
    if (request.command === 'read') {
      return { readiness: { ax_trusted: true, screen_capture: true }, displays: [DISPLAY], frontmost: app, app,
        elements: request.max_nodes === 0 ? [] : [{ path: [0, 0], depth: 2, role: 'AXButton', title: 'Go', enabled: true, actions: ['AXPress'], frame: { x: 10, y: 10, width: 50, height: 20 } }], truncated: false };
    }
    log.push(`start ${request.pid}`);
    if (actDelay) await new Promise(resolve => setTimeout(resolve, actDelay));
    log.push('end');
    return failAct ? { events: [{ event: 'ax_action', ok: false, detail: 'gone' }], completed: false }
      : { events: request.events.map(event => ({ event: event.event, ok: true, detail: '' })), completed: true };
  };
  return { log, program };
}
const driverOn = (mac, settings = screenSettings()) => makeScreenDriver({ settings, home: '/nonexistent', program: mac.program,
  capture: async () => Buffer.from('p'), ocr: async () => ({ width: 2000, height: 1000, lines: [] }), wait: async () => {} });

// The host holds this Mac's desktop while the person is typing on it (read-data/work-places.json person_input); the test
// is about the reaction a refusal carries, so the person has been away for a minute, whoever is using the machine that runs it.
const awayFor = ns => argv => ({ code: 0, stdout: Buffer.from(argv[0] === 'ioreg' ? `"HIDIdleTime" = ${ns}` : ''), stderr: '' });
const placesAway = () => makePlaces({ home: mkdtempSync(join(tmpdir(), 'drive-reactions-')), exec: async argv => awayFor(60e9)(argv) });

test('a refusal carries the reaction the AI owes it, and the host passes it on', async () => {
  const driver = driverOn(pretendMac());
  await assert.rejects(driver.drive({ action: 'nonsense' }), error => { assert.equal(error.reaction, 'use_different_tool'); assert.equal(error.outcome, undefined); return true; });
  await assert.rejects(driver.drive({ action: 'press' }), error => { assert.equal(error.reaction, 'retry'); return true; });
  const answer = await runScreenTool('drive', { action: 'nonsense' }, {}, { places: placesAway });
  assert.equal(answer.reaction, 'use_different_tool');
  assert.match(answer.reaction_said, /look/);
  console.log('readback host refusal:', JSON.stringify(answer));
});

test('an action that stopped part-way says it may have run and sends the AI to look again', async () => {
  const driver = driverOn(pretendMac({ failAct: true }));
  await assert.rejects(driver.drive({ action: 'press', target: 'Go' }), error => {
    assert.equal(error.reaction, 'use_different_tool');
    assert.equal(error.outcome, 'unknown');
    assert.match(error.message, /may already have run/);
    assert.match(error.reaction_said, /look/);
    console.log('readback partial dispatch:', JSON.stringify({ reaction: error.reaction, outcome: error.outcome, message: error.message }));
    return true;
  });
});

test('off-limits classes are a policy: open by default, a refusal in place once switched on', async () => {
  const terminal = { name: 'Terminal', bundle_id: 'com.apple.Terminal', pid: 9 };
  const open = screenSettings();
  assert.equal(offLimitsClass(open, terminal), null);
  const openMac = pretendMac({ app: terminal });
  assert.equal((await driverOn(openMac).drive({ action: 'press', target: 'Go' })).dispatched, true);

  const closed = { ...structuredClone(open), off_limits: { ...open.off_limits, enabled: true } };
  assert.equal(offLimitsClass(closed, terminal).id, 'terminals');
  assert.equal(offLimitsClass(closed, APP), null);
  const mac = pretendMac({ app: terminal });
  await assert.rejects(driverOn(mac, closed).drive({ action: 'press', target: 'Go' }), error => {
    assert.equal(error.reaction, 'ask_user');
    assert.match(error.message, /Terminal is off limits.*it runs shell commands/);
    console.log('readback off limits:', error.message);
    return true;
  });
  assert.deepEqual(mac.log, [], 'nothing was dispatched');
});

test('two drives never interleave: the second waits for the first, and look is never queued', async () => {
  const mac = pretendMac({ actDelay: 30 });
  const driver = driverOn(mac);
  const [a, b] = await Promise.all([driver.drive({ action: 'press', target: 'Go' }), driver.drive({ action: 'press', target: 'Go' })]);
  assert.equal(a.dispatched && b.dispatched, true);
  assert.deepEqual(mac.log, ['start 7', 'end', 'start 7', 'end']);
  console.log('readback serialized acts:', mac.log.join(' > '));
  const off = { ...structuredClone(screenSettings()), acting: { one_at_a_time: false } };
  const free = pretendMac({ actDelay: 30 });
  await Promise.all([driverOn(free, off).drive({ action: 'press', target: 'Go' }), driverOn(free, off).drive({ action: 'press', target: 'Go' })]);
  assert.deepEqual(free.log.slice(0, 2), ['start 7', 'start 7'], 'with the policy off they overlap');
});
