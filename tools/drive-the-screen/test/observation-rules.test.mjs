import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observationVerdict, checkedRules } from '../read-data/observation-rules.mjs';
import { makeScreenDriver, screenSettings } from '../read-data/drive-the-screen.mjs';

const rules = (extra = {}) => ({ default_application: 'observe', default_website: 'observe', applications: [], websites: [], ...extra });
const app = ['com.apple.Safari', 'Safari'];

test('out of the box everything is observed; a private window never is', () => {
  assert.equal(shipped().observe, true);
  assert.deepEqual(observationVerdict(rules(), { identities: app, private: true }), { observe: false, why: 'private' });
});
function shipped() { return observationVerdict(screenSettings().observation, { identities: app, domain: 'example.com' }); }

test('block rows win in observe-by-default; allow rows open do_not_observe; subdomains match; browsers must pass both', () => {
  const blockBank = rules({ websites: [{ domain: 'bank.com', mode: 'block' }] });
  assert.equal(observationVerdict(blockBank, { identities: app, domain: 'login.bank.com' }).why, 'website');
  assert.equal(observationVerdict(blockBank, { identities: app, domain: 'notbank.com' }).observe, true);
  const allowList = rules({ default_application: 'do_not_observe', applications: [{ app: 'Notes', mode: 'allow' }, { app: 'Notes', mode: 'block' }, { app: 'Pages', mode: 'allow' }] });
  assert.equal(observationVerdict(allowList, { identities: ['notes'] }).why, 'application', 'block beats allow');
  assert.equal(observationVerdict(allowList, { identities: ['pages'] }).observe, true);
  assert.equal(observationVerdict(allowList, { identities: app }).why, 'application');
  assert.throws(() => checkedRules(rules({ applications: [{ app: 'x', mode: 'maybe' }] })), /allow or block/);
});

test('the screen reader refuses a blocked app before reading anything, in the DATA words', async () => {
  const open = screenSettings();
  const settings = { ...structuredClone(open), observation: rules({ applications: [{ app: 'test.probe', mode: 'block' }] }) };
    const probe = { name: 'Probe', bundle_id: 'test.probe', pid: 1 };
  const program = async request => { return { readiness: { ax_trusted: true, screen_capture: true }, displays: [{ main: true, x: 0, y: 0, width: 10, height: 10 }], frontmost: probe, app: probe, elements: [] }; };
  const driver = makeScreenDriver({ settings, home: mkdtempSync(join(tmpdir(), 'obs-')), program, capture: async () => Buffer.alloc(0), ocr: async () => ({ lines: [] }), wait: async () => {} });
  await assert.rejects(driver.look(), error => { console.log('READBACK', error.status, error.reaction, error.message); return error.status === 403 && error.reaction === 'ask_user'; });
});
