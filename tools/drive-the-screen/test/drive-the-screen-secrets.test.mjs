// A saved login's value typed into the screen without the AI ever seeing it (read-data/drive-the-screen.mjs invariant 7):
// the call carries a reference, the Mac reads the value from the account at the moment of action, types it, and every
// answer and error of the call has it replaced by the DATA's mask. A rehearsal reads nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkedReference, makeScreenDriver, masked, screenSettings } from '../read-data/drive-the-screen.mjs';

const settings = screenSettings();
const PASSWORD = 'correct-horse-9!';
const DISPLAY = { index: 0, main: true, x: 0, y: 0, width: 1000, height: 500, scale: 2 };
const APP = { name: 'Probe', bundle_id: 'test.probe', pid: 4242 };

// A pretend Mac with one text field; `ax_set` and `text` steps put what they are given into it, and the field's value is read back.
function pretendMac({ failAct = false } = {}) {
  const state = { field: '', acts: [] };
  const program = async request => {
    if (request.command === 'read') {
      return { readiness: { ax_trusted: true, screen_capture: true }, displays: [DISPLAY], frontmost: APP, app: APP, truncated: false,
        elements: request.max_nodes === 0 ? [] : [
          { path: [0], depth: 1, role: 'AXWindow', title: 'Probe', frame: { x: 100, y: 100, width: 400, height: 300 } },
          { path: [0, 0], depth: 2, role: 'AXTextField', description: 'Password field', value: state.field, enabled: true, frame: { x: 120, y: 220, width: 200, height: 20 } },
        ] };
    }
    state.acts.push(request.events);
    if (failAct) return { events: [{ event: 'ax_set', ok: false, detail: `refused ${request.events[0].value}` }], completed: false };
    for (const event of request.events) if (event.event === 'ax_set') state.field = event.value;
    return { events: request.events.map(event => ({ event: event.event, ok: true, detail: '' })), completed: true };
  };
  return { state, program };
}
const driverOn = (mac, readSecret) => makeScreenDriver({ settings, home: mkdtempSync(join(tmpdir(), 'secret-home-')), program: mac.program,
  capture: async () => Buffer.from('pixels'), ocr: async () => ({ width: 2000, height: 1000, lines: [] }), wait: async () => {}, readSecret });

const reader = (reads, { values = [{ label: 'Password', value: PASSWORD }], user_name = 'brian@example.com' } = {}) => async (tool, args, account) => {
  reads.push({ tool, args, origin: account.origin });
  return { login_id: args.login_id, title: 'Bank', site: 'bank.example', user_name, values };
};
const field = { action: 'set_value', target: { match: { description: 'Password field' } } };

test('a reference types the saved value, the AI sees only the mask, and the read goes through the account with the Mac\'s key', async () => {
  const mac = pretendMac();
  const reads = [];
  const done = await driverOn(mac, reader(reads)).drive({ ...field, value: { saved_login: { login_id: 'login_1', field: 'password' } },
    expect: [{ target: { match: { role: 'textfield', value: PASSWORD } } }] }, { origin: 'https://app.gettrillion.ai', key: 'k' });
  assert.equal(mac.state.field, PASSWORD, 'the real value reached the field');
  assert.deepEqual(reads, [{ tool: 'read_saved_login', args: { login_id: 'login_1' }, origin: 'https://app.gettrillion.ai' }]);
  assert.equal(done.dispatched, true);
  assert.equal(JSON.stringify(done).includes(PASSWORD), false, 'nothing the call answers holds the value');
  assert.ok(JSON.stringify(done).includes(settings.secrets.mask), 'the places it would have shown carry the mask');
});

test('user_name is read from the login itself, and a value that is not there is refused without typing anything', async () => {
  const mac = pretendMac();
  const reads = [];
  await driverOn(mac, reader(reads)).drive({ ...field, value: { saved_login: { login_id: 'login_1', field: 'user_name' } } }, {});
  assert.equal(mac.state.field, 'brian@example.com');
  await assert.rejects(driverOn(mac, reader(reads)).drive({ ...field, value: { saved_login: { login_id: 'login_1', field: 'PIN' } } }, {}),
    error => { assert.equal(error.status, 404); assert.match(error.message, /no field called PIN/); return true; });
});

test('a rehearsal reads nothing, the account\'s refusal is said and nothing is typed, and an error never carries the value', async () => {
  const mac = pretendMac();
  const reads = [];
  const rehearsal = await driverOn(mac, reader(reads)).drive({ ...field, value: { saved_login: { login_id: 'login_1', field: 'password' } }, dry_run: true }, {});
  assert.equal(reads.length, 0);
  assert.equal(rehearsal.dispatched, false);
  assert.ok(JSON.stringify(rehearsal.events).includes(settings.secrets.rehearsal_stand_in));
  const refused = async () => { throw new Error('ai_not_allowed'); };
  await assert.rejects(driverOn(mac, refused).drive({ ...field, value: { saved_login: { login_id: 'login_1', field: 'password' } } }, {}),
    error => { assert.equal(error.status, 403); assert.match(error.message, /could not be read for this call \(ai_not_allowed\)/); return true; });
  assert.equal(mac.state.acts.length, 0, 'nothing was typed');
  const failing = pretendMac({ failAct: true });
  await assert.rejects(driverOn(failing, reader([])).drive({ ...field, value: { saved_login: { login_id: 'login_1', field: 'password' } } }, {}),
    error => { assert.equal(error.message.includes(PASSWORD), false); assert.ok(error.message.includes(settings.secrets.mask)); return true; });
});

test('only a text input marked reference takes one, and a reference must be one the DATA knows', async () => {
  assert.throws(() => checkedReference(settings, { cookie: { id: 'x' } }), error => error.status === 400 && /reads saved_login/.test(error.message));
  assert.throws(() => checkedReference(settings, { saved_login: { login_id: 'a' } }), /saved_login.field/);
  assert.throws(() => checkedReference(settings, 'password'), /A reference is one object like \{ saved_login: \{ login_id, field \} \}/);
  const mac = pretendMac();
  await assert.rejects(driverOn(mac, reader([])).drive({ action: 'press', target: 'x', text: { saved_login: { login_id: 'l', field: 'f' } } }, {}), /does not take text/);
  assert.equal(masked({ a: ['xx secret xx'], b: 'secret' }, ['secret'], '#').a[0], 'xx # xx');
});
