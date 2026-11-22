// test/click-on-this-macs-screen.test.mjs
//
// tool:click-on-this-macs-screen and the hard deny list (read-data/hard-deny.json) on a stand-in screen program: nothing here
// touches a real screen. A named button is clicked with a capture identity before and after; a point resolves to the element
// under it; and every rule refuses by its id, both on what is asked (before the screen is read) and on the resolved target
// (before anything is done, a rehearsal too): System Settings' Privacy & Security panes, password fields, payment buttons and
// the Mac's authentication sheets. Nothing in the call or the settings turns a rule off.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clickInput, makeScreenDriver, makeScreenTools, screenSettings } from '../read-data/drive-the-screen.mjs';
import { hardDenyList } from '../read-data/hard-deny.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const settings = screenSettings();
const DISPLAY = { index: 0, main: true, x: 0, y: 0, width: 1000, height: 600, scale: 2 };
const NOTES = { name: 'Notes', bundle_id: 'com.apple.Notes', pid: 501 };
const SETTINGS_APP = { name: 'System Settings', bundle_id: 'com.apple.systempreferences', pid: 502 };
const SHOP = { name: 'Shop', bundle_id: 'test.shop', pid: 503 };
const SECURITY_AGENT = { name: 'SecurityAgent', bundle_id: 'com.apple.SecurityAgent', pid: 504 };
const window = (title, children) => [{ path: [0], depth: 1, role: 'AXWindow', title, frame: { x: 0, y: 0, width: 900, height: 500 } },
  ...children.map((row, index) => ({ path: [0, index], depth: 2, enabled: true, actions: ['AXPress'], ...row }))];
const SCREENS = {
  Notes: { app: NOTES, rows: window('Notes', [{ role: 'AXButton', description: 'New Note', frame: { x: 20, y: 20, width: 40, height: 20 } },
    { role: 'AXTextField', description: 'Search', frame: { x: 100, y: 20, width: 200, height: 20 } }]) },
  'System Settings': { app: SETTINGS_APP, rows: window('Screen & System Audio Recording', [{ role: 'AXCheckBox', title: 'Example App', frame: { x: 600, y: 100, width: 40, height: 20 } }]) },
  Shop: { app: SHOP, rows: window('Checkout', [{ role: 'AXButton', title: 'Pay Now', frame: { x: 50, y: 400, width: 80, height: 30 } },
    { role: 'AXTextField', subrole: 'AXSecureTextField', description: 'Card security code', frame: { x: 50, y: 300, width: 80, height: 20 } },
    { role: 'AXButton', title: 'Privacy Policy', frame: { x: 50, y: 450, width: 80, height: 20 } }]) },
};

function pretend({ frontmost } = {}) {
  const acts = [];
  const reads = [];
  const program = async request => {
    if (request.command === 'read') {
      reads.push(request);
      const screen = request.app ? SCREENS[request.app] : Object.values(SCREENS).find(row => row.app.pid === request.pid) ?? SCREENS.Notes;
      if (!screen) return { readiness: { ax_trusted: true, screen_capture: true }, displays: [DISPLAY], frontmost: frontmost ?? NOTES, app: null, elements: [] };
      return { readiness: { ax_trusted: true, screen_capture: true }, displays: [DISPLAY], frontmost: frontmost ?? screen.app, app: screen.app, elements: request.max_nodes === 0 ? [] : screen.rows, truncated: false };
    }
    acts.push(request.events);
    return { events: request.events.map(event => ({ event: event.event, ok: true, detail: '' })), completed: true };
  };
  return { acts, reads, program };
}
const shots = ['before-pixels', 'after-pixels'];
const toolsOn = (mac, { capture } = {}) => {
  let shot = 0;
  const driver = home => makeScreenDriver({ settings, home, program: mac.program, parent: () => 4242, wait: async () => {},
    capture: capture ?? (async () => Buffer.from(shots[Math.min(shot++, 1)])), ocr: async () => ({ width: 2000, height: 1200, lines: [] }) });
  return makeScreenTools({ settings, driver, places: () => ({ handsOn: async () => undefined, acted: () => {} }), scratch: () => tempFolder(join(tmpdir(), 'click-home-')) });
};
const click = async (mac, input, options) => toolsOn(mac, options).drive(clickInput(settings, input));
const refusedBy = (answer, rule) => { assert.equal(answer.refused_by_rule, rule, JSON.stringify(answer)); assert.match(answer.error, new RegExp(`Refused by rule ${rule}`)); assert.match(answer.error, /Nothing was done\./); };

test('a named button in a named app is clicked, with a BLAKE3 capture identity before and after', async () => {
  const mac = pretend();
  const answer = await click(mac, { action: 'click', app: 'Notes', target: 'New Note' });
  assert.equal(answer.dispatched, true, JSON.stringify(answer));
  assert.equal(answer.targets.target.label, 'New Note');
  assert.equal(answer.captures.before.blake3, makeHashCodeHexFromBytes(Buffer.from('before-pixels')));
  assert.equal(answer.captures.after.blake3, makeHashCodeHexFromBytes(Buffer.from('after-pixels')));
  assert.notEqual(answer.captures.before.blake3, answer.captures.after.blake3);
  assert.equal(mac.acts.length, 1);
  assert.ok(mac.acts[0].some(event => event.x === 40 && event.y === 30), 'the click lands on the button centre');
});

test('a point from a fresh look resolves to the element under it, smallest first, and acts at the point', async () => {
  const mac = pretend();
  const answer = await click(mac, { action: 'click', app: 'Notes', target: { at: { x: 150, y: 25 } } });
  assert.equal(answer.dispatched, true);
  assert.equal(answer.targets.target.label, 'Search');
  assert.ok(mac.acts[0].some(event => event.x === 150 && event.y === 25));
  const off = await click(pretend(), { action: 'click', app: 'Notes', target: { at: { x: 5000, y: 5 } } });
  assert.match(off.error, /target|found|match/i, 'a point on no display finds nothing');
});

test('a click aimed at the Screen Recording pane is refused before the screen is read, by name or by its pane', async () => {
  const mac = pretend();
  refusedBy(await click(mac, { action: 'click', app: 'System Settings', target: 'Screen & System Audio Recording' }), 'privacy-and-security-settings');
  assert.equal(mac.reads.length, 0, 'nothing was read');
  refusedBy(await click(mac, { action: 'click', app: 'com.apple.systempreferences', target: 'Privacy & Security' }), 'privacy-and-security-settings');
  // Already in the pane: the toggle is aimed at by its label, then by a point; refused on the resolved target, the rehearsal too.
  const inPane = pretend();
  refusedBy(await click(inPane, { action: 'click', app: 'System Settings', target: 'Example App' }), 'privacy-and-security-settings');
  refusedBy(await click(inPane, { action: 'click', app: 'System Settings', target: { at: { x: 610, y: 110 } }, dry_run: true }), 'privacy-and-security-settings');
  assert.equal(inPane.acts.length, 0, 'nothing was done');
});

test('password fields are refused: by name before reading, by role on the resolved target, and typing blind on a screen that holds one', async () => {
  const mac = pretend();
  refusedBy(await click(mac, { action: 'type', app: 'Notes', target: 'Password', text: 'x' }), 'password-and-passkey-fields');
  refusedBy(await click(mac, { action: 'type', app: 'Shop', target: 'Card security code', text: '123' }), 'password-and-passkey-fields');
  refusedBy(await click(mac, { action: 'click', app: 'Shop', target: { at: { x: 60, y: 305 } } }), 'password-and-passkey-fields');
  refusedBy(await click(mac, { action: 'type', app: 'Shop', text: 'hello' }), 'password-and-passkey-fields');
  assert.equal(mac.acts.length, 0);
});

test('payment confirmations and the authentication sheets are refused; an ordinary button in the same app is not', async () => {
  refusedBy(await click(pretend(), { action: 'click', app: 'Shop', target: 'Pay Now' }), 'payment-confirmations');
  refusedBy(await click(pretend(), { action: 'click', app: 'SecurityAgent', target: 'OK' }), 'authentication-sheets');
  // An authentication sheet in front stops a drive of another app: its keys would go to the sheet.
  refusedBy(await click(pretend({ frontmost: SECURITY_AGENT }), { action: 'click', app: 'Notes', target: 'New Note' }), 'authentication-sheets');
  const shop = pretend();
  const policy = await click(shop, { action: 'click', app: 'Shop', target: 'Privacy Policy' });
  assert.equal(policy.dispatched, true, 'privacy words outside System Settings are not a settings pane');
});

test('nothing turns a rule off, and the answer is the typed Screen Recording refusal when the Mac will not capture', async () => {
  const list = hardDenyList();
  assert.ok(!JSON.stringify(Object.keys(list)).match(/enabled|switch|allow/), 'the list has no switch');
  assert.ok(list.rules.every(rule => rule.id && rule.said && rule.when.length));
  assert.throws(() => clickInput(settings, { action: 'click', app: 'Notes', target: 'New Note', record_captures: false }), /record_captures/);
  const refused = await click(pretend(), { action: 'click', app: 'Notes', target: 'New Note' }, { capture: async () => { throw new Error('could not create image from display'); } });
  assert.equal(refused.permission, 'screen_capture');
  assert.equal(refused.code, settings.permission_code);
});

test('the four actions map onto the driver rows, and a click needs its target and app', () => {
  assert.deepEqual(clickInput(settings, { action: 'open', app: 'Notes', target: 'x' }), { action: 'activate', app: 'Notes', record_captures: true });
  assert.deepEqual(clickInput(settings, { action: 'press_key', app: 'Notes', keys: 'cmd+n' }), { action: 'key', app: 'Notes', keys: 'cmd+n', record_captures: true });
  assert.throws(() => clickInput(settings, { action: 'click', app: 'Notes' }), /target/);
  assert.throws(() => clickInput(settings, { action: 'click', target: 'x' }), /app/);
  assert.throws(() => clickInput(settings, { action: 'drag', app: 'Notes' }), /drag/);
  assert.deepEqual(clickInput(settings, { action: 'open', app: 'Notes', computer: { 'drive-the-screen': {} } }), { action: 'activate', app: 'Notes', record_captures: true }, 'the engine\'s grant targets are not a tool input');
});

test('a deny-list refusal comes before the person\'s place is read or any program starts', async () => {
  const mac = pretend();
  let placeRead = false;
  const tools = makeScreenTools({ settings, driver: home => makeScreenDriver({ settings, home, program: mac.program, parent: () => 4242 }),
    places: () => ({ handsOn: async () => { placeRead = true; throw new Error('spawn EPERM'); }, acted: () => {} }), scratch: () => tempFolder(join(tmpdir(), 'click-home-')) });
  refusedBy(await tools.drive(clickInput(settings, { action: 'click', app: 'System Settings', target: 'Screen & System Audio Recording', dry_run: true })), 'privacy-and-security-settings');
  assert.equal(placeRead, false);
  assert.equal(mac.reads.length, 0);
});
