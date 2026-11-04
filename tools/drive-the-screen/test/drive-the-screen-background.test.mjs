// test/drive-the-screen-background.test.mjs
//
// Working in the background on this Mac (read-data/drive-the-screen.mjs, read-data/screen-driver.swift) on a pretend Mac:
// a background drive posts input to the process and never brings it forward; a foreground drive is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeScreenDriver, screenSettings } from '../read-data/drive-the-screen.mjs';

const settings = screenSettings();
const APP = { name: 'Probe', bundle_id: 'test.probe', pid: 4242 };
const DISPLAY = { index: 0, main: true, x: 0, y: 0, width: 1000, height: 500, scale: 2 };

// A pretend Mac with one app whose window holds one button.
function pretendMac() {
  const state = { asked: [] };
  const program = async request => {
    state.asked.push(request);
    if (request.command === 'read') {
      return { readiness: { ax_trusted: true, screen_capture: true }, displays: [DISPLAY], frontmost: { name: 'Mail', pid: 1 }, app: APP, truncated: false,
        elements: request.max_nodes === 0 ? [] : [{ path: [0], depth: 1, role: 'AXWindow', title: 'Main', frame: { x: 100, y: 100, width: 400, height: 300 } },
          { path: [0, 0], depth: 2, role: 'AXButton', title: 'Go', actions: ['AXPress'], frame: { x: 120, y: 120, width: 60, height: 20 } }] };
    }
    return { events: request.events.map(event => ({ event: event.event, ok: true, detail: '' })), completed: true };
  };
  return { state, program };
}

const driver = mac => makeScreenDriver({ settings, home: mkdtempSync(join(tmpdir(), 'background-drive-')), program: mac.program,
  capture: async () => Buffer.from(''), ocr: async () => ({ width: 2000, height: 1000, lines: [] }), wait: async () => {} });

test('a background drive posts to the process and leaves out bringing the app forward', async () => {
  const mac = pretendMac();
  const screen = driver(mac);
  const action = Object.entries(settings.actions).find(([, row]) => row.steps.some(step => step.event === 'app_activate'));
  assert.ok(action, 'the DATA has an action that brings its app forward');
  const done = await screen.drive({ action: action[0], target: 'Go', app: 'Probe', background: true, ...Object.fromEntries(Object.entries(action[1].inputs ?? {}).filter(([, spec]) => spec.required).map(([name, spec]) => [name, spec.type === 'chord' ? 'return' : spec.type === 'string' ? 'x' : 1])) });
  const act = mac.state.asked.find(request => request.command === 'act');
  assert.equal(act.deliver, settings.background.deliver);
  assert.equal(act.events.some(event => settings.background.skip_events.includes(event.event)), false);
  assert.equal(done.background, true);
  await assert.rejects(screen.drive({ action: action[0], target: 'Go', background: 'yes' }), /background must be true or false/);
  await screen.drive({ action: 'press', target: 'Go', app: 'Probe' });
  assert.equal(mac.state.asked.filter(request => request.command === 'act').at(-1).deliver, undefined, 'a foreground drive is unchanged');
});
