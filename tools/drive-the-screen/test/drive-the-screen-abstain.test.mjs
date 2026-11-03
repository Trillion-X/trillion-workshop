// The screen driver can refuse an ambiguous target (read-data/drive-the-screen.json `abstain`). Carried from
// Trillion-X/trillion test/confidence-filter.test.mjs; its first two tests are of src/confidence-filter.mjs, which stays there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScreenDriver, screenSettings } from '../read-data/drive-the-screen.mjs';

test('the screen driver abstains from an ambiguous target only when the person turns that on, and says what matched', async () => {
  const open = screenSettings();
  assert.equal(open.abstain.enabled, false);
  const D = { index: 0, main: true, x: 0, y: 0, width: 1000, height: 500, scale: 2 };
  const P = { name: 'Probe', bundle_id: 'p', pid: 7 };
  const rows = [{ path: [0], depth: 1, role: 'AXWindow', title: 'W', frame: { x: 0, y: 0, width: 500, height: 400 } },
    { path: [0, 0], depth: 2, role: 'AXButton', title: 'Save', enabled: true, actions: ['AXPress'], frame: { x: 10, y: 10, width: 50, height: 20 } },
    { path: [0, 1], depth: 2, role: 'AXButton', title: 'Save', enabled: true, actions: ['AXPress'], frame: { x: 10, y: 60, width: 50, height: 20 } }];
  const sent = [];
  const program = async request => request.command === 'read'
    ? { readiness: { ax_trusted: true, screen_capture: true }, displays: [D], frontmost: P, app: P, elements: request.max_nodes === 0 ? [] : rows, truncated: false }
    : (sent.push(request), { events: request.events.map(e => ({ event: e.event, ok: true, detail: '' })), completed: true });
  const make = settings => makeScreenDriver({ settings, program, capture: async () => Buffer.from('x'), ocr: async () => ({ width: 2000, height: 1000, lines: [] }), wait: async () => {} });
  await make(open).drive({ action: 'press', target: 'Save' });
  assert.equal(sent.length, 1, 'default: the best of two is used');
  const strict = { ...structuredClone(open), abstain: { ...open.abstain, enabled: true } };
  await assert.rejects(make(strict).drive({ action: 'press', target: 'Save' }), error => error.status === 409 && error.retry === false && /2 things matched/.test(error.message));
  assert.equal(sent.length, 1, 'nothing was done');
  await make(strict).drive({ action: 'press', target: { match: { label: 'Save' }, nth: 1 } });
  assert.equal(sent.length, 2, 'naming which one removes the ambiguity');
});
