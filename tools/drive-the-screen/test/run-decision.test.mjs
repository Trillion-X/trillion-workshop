// The Mac screen driver's one decision table (read-data/run-decision.mjs): nothing is on by default; the person's deny
// beats their allow beats an organisation's deny beats its allow; strict refuses what no allow rule admits; reading is
// an action too; controls keep the last record fetched; proposals come from approvals already given.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, decisionSettings, readLists, refreshControls, requireAllowed, ruleHolds, ruleTools } from '../read-data/run-decision.mjs';
import { grantTools, makeScreenDriver, screenSettings } from '../read-data/drive-the-screen.mjs';

const settings = decisionSettings();
const home = () => mkdtempSync(join(tmpdir(), 'decision-home-'));
const subject = (action, app = 'Safari') => ({ action, app: [app, `com.example.${app.toLowerCase()}`] });

test('with no files at all every action is allowed, and the table says nothing is on by default', () => {
  const dir = home();
  assert.equal(requireAllowed(settings, dir, subject('press')).decision, 'allow');
  assert.equal(requireAllowed(settings, dir, subject('look', 'Keychain Access')).by, 'otherwise');
});

test('precedence: person deny, person allow, organisation deny, organisation allow; first match wins', () => {
  const lists = { user_deny: [{ app: 'Keychain*' }], user_allow: [{ action: 'press' }, { app: 'Keychain Access' }],
    system_deny: [{ action: 'press', app: 'Banking' }, { url: '*.corp.example' }], system_allow: [{ action: 'look' }] };
  assert.deepEqual(decide(settings, lists, subject('look', 'Keychain Access')).by, 'user_deny', 'deny beats allow');
  assert.deepEqual(decide(settings, lists, subject('press', 'Banking')).by, 'user_allow', 'person allow beats organisation deny');
  assert.deepEqual(decide(settings, lists, { action: 'type', app: ['Banking'], url: 'x.corp.example' }), { decision: 'deny', by: 'system_deny', rule: { url: '*.corp.example' } });
  assert.equal(decide(settings, lists, subject('look')).by, 'system_allow');
  assert.equal(decide(settings, lists, subject('scroll')).decision, 'allow');
  assert.equal(decide(settings, lists, subject('scroll'), { strict: true }).decision, 'deny', 'strict refuses what nothing admits');
  assert.equal(ruleHolds({}, subject('anything')), true);
});

test('the person\'s commands write rules and strict, and the driver reads them at the moment of action, reading included', async () => {
  const dir = home();
  const tools = ruleTools(settings, { home: dir });
  assert.match(tools.add({ list: 'user_deny', rule: { app: 'Keychain Access' } }).said, /Added to user_deny/);
  assert.throws(() => tools.add({ list: 'user_deny', rule: { colour: 'red' } }), /its parts are action, app, url/);
  assert.throws(() => tools.add({ list: 'system_allow', rule: { app: 'x' } }), /They are user_deny, user_allow/);
  const app = { name: 'Keychain Access', bundle_id: 'com.apple.keychainaccess', pid: 7 };
  const program = async request => ({ readiness: { ax_trusted: true, screen_capture: true }, displays: [{ index: 0, main: true, x: 0, y: 0, width: 100, height: 100, scale: 2 }], frontmost: app, app, elements: request.max_nodes === 0 ? [] : [], truncated: false });
  const driver = makeScreenDriver({ settings: screenSettings(), home: dir, program, capture: async () => Buffer.from('p'), ocr: async () => ({ width: 200, height: 200, lines: [] }), wait: async () => {} });
  await assert.rejects(driver.look({ app: 'Keychain Access' }), error => { assert.equal(error.status, 403); assert.match(error.message, /look in keychain access is not allowed by user_deny/); return true; });
  tools.remove({ list: 'user_deny', rule: { app: 'Keychain Access' } });
  assert.ok((await driver.look({ app: 'Keychain Access' })).counts);
  tools.strict(true);
  await assert.rejects(driver.look({ app: 'Keychain Access' }), /strict setting is on/);
  tools.add({ list: 'user_allow', rule: { action: 'look' } });
  assert.ok((await driver.look({ app: 'Keychain Access' })).counts);
});

test('a rules file that cannot be trusted refuses instead of allowing', () => {
  const dir = home();
  mkdirSync(join(dir, '.trillion/screen-driving'), { recursive: true });
  const file = join(dir, settings.rules_file);
  writeFileSync(file, '{ not json');
  assert.equal(readLists(settings, dir).ok, false);
  assert.throws(() => requireAllowed(settings, dir, subject('look')), /rules file could not be read/);
  writeFileSync(file, '{"strict":false}'); chmodSync(file, 0o666);
  assert.equal(readLists(settings, dir).ok, false, 'writable by others');
});

test('organisation controls arrive as one record, a failed refresh keeps the last good one, and with none the table denies', async () => {
  const dir = home();
  const withSource = { ...settings, controls: { ...settings.controls, source: 'https://controls.example/screen' } };
  assert.deepEqual(await refreshControls(settings, { home: dir }), { refreshed: false, reason: 'no source' }, 'nothing is fetched without a source');
  assert.throws(() => requireAllowed(withSource, dir, subject('look')), /never been fetched/);
  const good = { ok: true, json: async () => ({ system_deny: [{ app: 'Banking' }], strict: false }) };
  assert.equal((await refreshControls(withSource, { home: dir, fetchImpl: async () => good })).refreshed, true);
  assert.throws(() => requireAllowed(withSource, dir, subject('press', 'Banking')), /not allowed by system_deny/);
  const file = join(dir, withSource.controls.file);
  const later = Date.now() + 2 * 3600_000;
  utimesSync(file, new Date(), new Date());
  const failed = await refreshControls(withSource, { home: dir, fetchImpl: async () => { throw new Error('offline'); }, now: () => later });
  assert.deepEqual([failed.refreshed, failed.kept], [false, 'last good']);
  assert.throws(() => requireAllowed(withSource, dir, subject('press', 'Banking')), /not allowed by system_deny/, 'the restriction stands');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).system_deny[0].app, 'Banking');
});

test('approvals the person gave become allow proposals after enough repeats, and an accepted rule stops being proposed', () => {
  const dir = home();
  const screen = screenSettings();
  const grants = grantTools(screen, { home: dir });
  for (let i = 0; i < settings.proposal.min_repeats; i += 1) grants.grant({ actions: ['press'], apps: ['Safari'], minutes: 5 });
  grants.grant({ actions: ['scroll'], minutes: 5 });
  const tools = ruleTools(settings, { home: dir });
  assert.deepEqual(tools.propose().proposals, [{ rule: { action: 'press', app: 'Safari' }, approved_times: 3 }]);
  tools.add({ list: 'user_allow', rule: { action: 'press', app: 'Safari' } });
  assert.deepEqual(tools.propose().proposals, []);
  assert.ok(existsSync(join(dir, settings.proposal.history_file)));
});

test('the driver names the Mac permission each source of the screen needs, in DATA', async () => {
  const screen = screenSettings();
  assert.deepEqual(screen.elements.source_permissions, { ax: 'ax_trusted', ocr: 'screen_capture' });
  for (const name of Object.values(screen.elements.source_permissions)) assert.ok(Object.hasOwn(screen.readiness, name), `${name} has its words`);
});
