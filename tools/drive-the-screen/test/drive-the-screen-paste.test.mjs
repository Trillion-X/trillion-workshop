// The paste action (read-data/drive-the-screen.json `paste`, event run by read-data/screen-driver.swift): the text goes through a
// promised clipboard item, so the answer says whether the app really read it; a secret reference works as for type.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeScreenDriver, screenSettings } from '../read-data/drive-the-screen.mjs';

const settings = screenSettings();
const APP = { name: 'Probe', bundle_id: 'test.probe', pid: 4242 };
const DISPLAY = { index: 0, main: true, x: 0, y: 0, width: 1000, height: 500, scale: 2 };
const mac = (landed) => {
  const acts = [];
  return { acts, program: async request => {
    if (request.command === 'read') return { readiness: { ax_trusted: true, screen_capture: true }, displays: [DISPLAY], frontmost: APP, app: APP, truncated: false, elements: [] };
    acts.push(request.events);
    const done = request.events.map(event => event.event === 'paste' && !landed
      ? { event: 'paste', ok: false, detail: 'The app did not read the pasted text in time; the clipboard was put back (1 item(s)).' }
      : { event: event.event, ok: true, detail: event.event === 'paste' ? 'The app read the pasted text; the clipboard was put back (1 item(s)).' : '' });
    return { events: done, completed: done.every(row => row.ok) };
  } };
};
const driver = pretend => makeScreenDriver({ settings, home: mkdtempSync(join(tmpdir(), 'paste-')), program: pretend.program, capture: async () => Buffer.from('p'),
  ocr: async () => ({ width: 2000, height: 1000, lines: [] }), wait: async () => {}, readSecret: async () => ({ values: [{ label: 'Password', value: 'hunter2-long' }] }) });

test('paste is a DATA action whose last step is the paste event, and the answer carries what the app did', async () => {
  assert.equal(settings.actions.paste.steps.at(-1).event, 'paste');
  const ok = mac(true);
  const done = await driver(ok).drive({ action: 'paste', text: 'hello' });
  assert.equal(done.dispatched, true);
  assert.match(done.results[0].detail, /app read the pasted text/);
  assert.deepEqual(ok.acts[0], [{ event: 'paste', text: 'hello', timeout_ms: 1500 }]);
});

test('a paste the app never read is a refused dispatch naming it, and a secret reference is masked', async () => {
  await assert.rejects(driver(mac(false)).drive({ action: 'paste', text: 'hello' }), error => { assert.equal(error.status, 502); assert.match(error.message, /did not read the pasted text/); return true; });
  const hidden = mac(true);
  const done = await driver(hidden).drive({ action: 'paste', text: { saved_login: { login_id: 'l', field: 'password' } } }, {});
  assert.equal(hidden.acts[0][0].text, 'hunter2-long');
  assert.equal(JSON.stringify(done).includes('hunter2-long'), false);
});

test('the Swift driver knows the paste event and keeps the focus check for it', () => {
  const swift = readFileSync(new URL('../read-data/screen-driver.swift', import.meta.url), 'utf8');
  assert.match(swift, /case "paste":/);
  assert.match(swift, /"text", "paste", "ax_action"/);
});
