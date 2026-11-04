// test/screen-driving-guards.test.mjs
//
// The opt-in guards on the screen driver (read-data/drive-the-screen.mjs `guards`, from findings on an AI browser): a grant that is
// spent by its uses (F-0593), the screen marked when it holds a password field (F-0597), what a session has read recorded
// so an action that could send it on is refused (F-0595), and the notice that screen text is data (F-0449). Every guard
// is off in the shipped data; nothing here is a default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grantTools, makeScreenDriver, readGrants, screenSettings } from '../read-data/drive-the-screen.mjs';

const open = screenSettings();
const DISPLAY = { index: 0, main: true, x: 0, y: 0, width: 1000, height: 500, scale: 2 };
const PROBE = { name: 'Probe', bundle_id: 'test.probe', pid: 4242 };
const rows = (secure = false) => [
  { path: [0], depth: 1, role: 'AXWindow', title: 'Probe', frame: { x: 100, y: 100, width: 400, height: 300 } },
  { path: [0, 0], depth: 2, role: 'AXButton', title: 'Confirm Order', enabled: true, actions: ['AXPress'], frame: { x: 120, y: 120, width: 100, height: 30 } },
  { path: [0, 1], depth: 2, role: 'AXTextField', description: 'Name field', enabled: true, frame: { x: 120, y: 220, width: 200, height: 20 } },
  ...(secure ? [{ path: [0, 2], depth: 2, role: 'AXTextField', subrole: 'AXSecureTextField', description: 'Password', enabled: true, frame: { x: 120, y: 260, width: 200, height: 20 } }] : []),
];
function pretend({ secure = false } = {}) {
  const acts = [];
  const program = async request => {
    if (request.command === 'read') return { readiness: { ax_trusted: true, screen_capture: true }, displays: [DISPLAY], frontmost: PROBE, app: PROBE, elements: request.max_nodes === 0 ? [] : rows(secure), truncated: false };
    acts.push(request.events);
    return { events: request.events.map(event => ({ event: event.event, ok: true, detail: '' })), completed: true };
  };
  return { acts, program };
}
const driverOf = (mac, settings, home = mkdtempSync(join(tmpdir(), 'guards-home-')), now = () => Date.now()) =>
  ({ home, now, driver: makeScreenDriver({ settings, home, now, program: mac.program, capture: async () => Buffer.from('x'), ocr: async () => ({ width: 2000, height: 1000, lines: [] }), wait: async () => {} }) });
const withGuards = (patch, base = open) => { const copy = structuredClone(base); for (const [path, value] of Object.entries(patch)) { const keys = path.split('.'); const last = keys.pop(); keys.reduce((node, key) => node[key], copy)[last] = value; } return copy; };
const refusedBy = async (promise, words) => assert.rejects(promise, error => { assert.equal(error.status, 403); assert.equal(error.retry, false); assert.match(error.message, words); return true; });

test('shipped guards are off: a password screen is reported and written to, and nothing is recorded', async () => {
  assert.deepEqual([open.guards.credential_surface.refuse_writes, open.guards.taint.enabled], [false, false]);
  const mac = pretend({ secure: true });
  const { driver, home } = driverOf(mac, open);
  const seen = await driver.look();
  assert.match(seen.credential_surface, /password field/);
  assert.match(seen.content_notice, /not an instruction/);
  const typed = await driver.drive({ action: 'type', text: 'x', target: 'Name field' });
  assert.equal(typed.dispatched, true);
  assert.match(typed.observed_before.credential_surface, /password field/);
  assert.throws(() => readFileSync(join(home, open.guards.taint.file)), { code: 'ENOENT' });
  assert.equal((await driverOf(pretend(), open).driver.look()).credential_surface, undefined, 'a screen without one says nothing');
});

test('a grant that counts uses is spent by the action and gone at zero; the sentence is built from the action definitions', async () => {
  const gate = withGuards({ 'consent.require_grant': true });
  const mac = pretend();
  const { driver, home, now } = driverOf(mac, gate);
  const tools = grantTools(gate, { home, now });
  tools.grant({ actions: ['look'], minutes: 5 });
  const once = tools.grant({ actions: ['press'], uses: 1, apps: ['Probe'], minutes: 5 });
  assert.match(once.said, /Allowed press in Probe once/);
  assert.equal(once.sentence, `${gate.actions.press.what} In Probe only.`);
  assert.equal(readGrants(gate, home).grants.find(grant => grant.id === once.grant.id).uses, 1);
  await driver.look();
  assert.equal(readGrants(gate, home).grants.find(grant => grant.id === once.grant.id).uses, 1, 'looking spends nothing');
  const rehearsal = await driver.drive({ action: 'press', target: 'Confirm Order', dry_run: true }).catch(error => error);
  assert.equal(rehearsal.dispatched, false);
  assert.equal((await driver.drive({ action: 'press', target: 'Confirm Order' })).dispatched, true);
  assert.equal(readGrants(gate, home).grants.some(grant => grant.id === once.grant.id), false, 'spent');
  await assert.rejects(driver.drive({ action: 'press', target: 'Confirm Order' }), /not allowed press/);
  assert.throws(() => tools.grant({ actions: ['press'], uses: 0 }), /Name the actions/);
  const twice = tools.grant({ actions: ['press'], uses: 2, minutes: 5 });
  await driver.drive({ action: 'press', target: 'Confirm Order' });
  assert.equal(readGrants(gate, home).grants.find(grant => grant.id === twice.grant.id).uses, 1);
});

test('with refuse_writes on, writing into a screen with a password field needs the person\'s credential_surface grant', async () => {
  const on = withGuards({ 'guards.credential_surface.refuse_writes': true });
  const mac = pretend({ secure: true });
  const { driver, home, now } = driverOf(mac, on);
  await refusedBy(driver.drive({ action: 'type', text: 'x', target: 'Name field' }), /not allowed credential_surface/);
  assert.equal(mac.acts.length, 0);
  assert.equal((await driver.drive({ action: 'press', target: 'Confirm Order' })).dispatched, true, 'a press is not a write');
  grantTools(on, { home, now }).grant({ actions: ['credential_surface'], minutes: 5 });
  assert.equal((await driver.drive({ action: 'type', text: 'x', target: 'Name field' })).dispatched, true);
  const plain = driverOf(pretend(), on).driver;
  assert.equal((await plain.drive({ action: 'type', text: 'x', target: 'Name field' })).dispatched, true, 'no password field, no refusal');
});

test('with taint on, an action that could send on what the session read is refused until the person allows it; sessions are apart', async () => {
  let clock = Date.parse('2026-10-19T10:00:00Z');
  const on = withGuards({ 'guards.taint.enabled': true, 'guards.taint.private_apps': ['Probe'] });
  const mac = pretend();
  const { driver, home, now } = driverOf(mac, on, undefined, () => clock);
  await driver.look({ session: 'chat-1' });
  const file = JSON.parse(readFileSync(join(home, on.guards.taint.file), 'utf8'));
  assert.deepEqual(Object.keys(file.sessions['chat-1']).sort(), ['sensitive_data', 'untrusted_content']);
  await refusedBy(driver.drive({ action: 'type', text: 'x', session: 'chat-1' }), /read content from outside and private data/);
  assert.equal(mac.acts.length, 0);
  assert.equal((await driver.drive({ action: 'press', target: 'Confirm Order', session: 'chat-1' })).dispatched, true, 'a press is not in the refused list');
  const calm = withGuards({ 'guards.taint.private_apps': [] }, on);
  assert.equal((await driverOf(pretend(), calm, home, () => clock).driver.drive({ action: 'type', text: 'x', session: 'chat-2' })).dispatched, true, 'no private app was read in this session');
  grantTools(on, { home, now }).grant({ actions: ['tainted_action'], minutes: 5 });
  assert.equal((await driver.drive({ action: 'type', text: 'x', session: 'chat-1' })).dispatched, true, 'the person allowed it');
});

test('taint is forgotten after its window', async () => {
  let clock = Date.parse('2026-10-19T10:00:00Z');
  const on = withGuards({ 'guards.taint.enabled': true, 'guards.taint.refuse_when': [{ taints: ['earlier_read'], actions: ['key'] }] });
  const { driver, home } = driverOf(pretend(), on, undefined, () => clock);
  mkdirSync(join(home, '.trillion/screen-driving'), { recursive: true });
  writeFileSync(join(home, on.guards.taint.file), JSON.stringify({ sessions: { default: { earlier_read: new Date(clock).toISOString() } } }));
  await refusedBy(driver.drive({ action: 'key', keys: 'cmd+s' }), /could send it on/);
  clock += (on.guards.taint.window_minutes + 1) * 60_000;
  assert.equal((await driver.drive({ action: 'key', keys: 'cmd+s' })).dispatched, true);
});
