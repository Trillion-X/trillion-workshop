// test/hold-this-mac.test.mjs
//
// Holding the Mac quiet for a session (computer/hold-this-mac.mjs) on a pretend Mac: a hold closes the named open apps
// politely (ending one only when the polite way is refused), never closes an always-open app, turns Focus on through
// its shortcut, ends by itself at its time (Focus off with it), is capped so it can never keep the person out, and is
// picked up again after the helper restarts. A hold naming `only` closes every app but those and the always-open ones. A Mac without the Focus shortcut gets it signed and opened to add.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appsUsing, closableApps, closedBy, holdSettings, keptIdentities, makeHolds, pidsUsing, placeRows, runningApps, untilOf } from '../computer/hold-this-mac.mjs';

const LSAPPINFO = [
  ' 1) "Finder" ASN:0x0-0x1001: ',
  '    bundleID="com.apple.finder"',
  '    pid = 501 type="Foreground" flavor=3 Version="1" fileType="FNDR" Arch=ARM64 ',
  ' 2) "Messages" ASN:0x0-0x2002: ',
  '    bundleID="com.apple.MobileSMS"',
  '    pid = 777 type="Foreground" flavor=3 Version="1" fileType="APPL" Arch=ARM64 ',
  ' 3) "WindowManager" ASN:0x0-0x3003: ',
  '    pid = 655 type="UIElement" flavor=3 Version="1" fileType="APPL" Arch=ARM64 ',
  ' 4) "Slack" ASN:0x0-0x4004: ',
  '    pid = 888 type="Foreground" flavor=3 Version="1" fileType="APPL" Arch=ARM64 ',
].join('\n');

function pretendMac({ shortcuts = ['Trillion Focus on', 'Trillion Focus off'], refuseQuit = [] } = {}) {
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'shortcuts' && args[0] === 'list') return { ok: true, stdout: shortcuts.join('\n'), stderr: '' };
    if (file === 'lsappinfo') return { ok: true, stdout: LSAPPINFO, stderr: '' };
    if (file === 'osascript' && refuseQuit.some(name => args[1].includes(name))) return { ok: false, stdout: '', stderr: 'Not authorized to send Apple events (-1743)' };
    return { ok: true, stdout: '', stderr: '' };
  };
  const intervals = [];
  const timers = { setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval: () => { intervals.length = 0; } };
  return { exec, calls, timers, intervals };
}

const settings = holdSettings();

test('running apps are read from lsappinfo, foreground ones only, with every identity they have', () => {
  assert.deepEqual(runningApps(LSAPPINFO), [{ name: 'Finder', bundle_id: 'com.apple.finder', pid: 501 }, { name: 'Messages', bundle_id: 'com.apple.MobileSMS', pid: 777 }, { name: 'Slack', pid: 888 }]);
});

test('a hold needs an end, and never lasts longer than the longest hold', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  assert.equal(untilOf({}, settings, now), null);
  assert.equal(untilOf({ minutes: 90 }, settings, now).until, '2026-10-05T13:30:00.000Z');
  const long = untilOf({ until: '2026-10-07T12:00:00Z' }, settings, now);
  assert.equal(long.capped, true);
  assert.equal(long.until, new Date(now + settings.longest_hours * 3_600_000).toISOString());
});

test('always-open apps are never closed, whatever a hold names', () => {
  assert.deepEqual(closableApps(['Finder', 'Messages', 'trillion', 'Slack'], settings), ['Messages', 'Slack']);
  assert.deepEqual(closableApps(undefined, settings), settings.default_apps);
});

test('a hold turns Focus on, closes named open apps politely, and ends by itself with Focus off', async () => {
  const home = await mkdtemp(join(tmpdir(), 'trillion-hold-'));
  let clock = Date.parse('2026-10-05T12:00:00Z');
  const mac = pretendMac({ refuseQuit: ['Slack'] });
  const holds = makeHolds({ settings, home, exec: mac.exec, now: () => clock, timers: mac.timers });
  const held = await holds.hold({ id: 'session-1', apps: ['Messages', 'Slack', 'Finder'], minutes: 90 });
  assert.deepEqual(held.hold.apps, ['Messages', 'Slack']);
  assert.ok(mac.calls.some(call => call.join(' ') === 'shortcuts run Trillion Focus on'));
  assert.ok(mac.calls.some(call => call[0] === 'osascript' && call[2] === 'quit app "Messages"'));
  // Slack refused the polite quit, so it is ended; Finder is never touched.
  assert.ok(mac.calls.some(call => call.join(' ') === 'kill -TERM 888'));
  assert.ok(!mac.calls.some(call => call.join(' ').includes('Finder')));
  assert.equal(mac.intervals.length, 1);
  assert.match(held.said, /held until 2026-10-05T13:30:00.000Z/);
  // Past its end, the next look drops it, turns Focus off and stops watching.
  clock = Date.parse('2026-10-05T13:31:00Z');
  await holds.look();
  assert.ok(mac.calls.some(call => call.join(' ') === 'shortcuts run Trillion Focus off'));
  assert.deepEqual((await holds.holds()).holds, []);
  assert.equal(mac.intervals.length, 0);
});

test('release ends a hold now and a restart picks up a hold that still lasts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'trillion-hold-'));
  const clock = Date.parse('2026-10-05T12:00:00Z');
  const mac = pretendMac();
  const first = makeHolds({ settings, home, exec: mac.exec, now: () => clock, timers: mac.timers });
  await first.hold({ id: 'a', apps: ['Messages'], minutes: 30 });
  // The helper restarts: a fresh copy reads the same file and watches again.
  const again = pretendMac();
  const restarted = makeHolds({ settings, home, exec: again.exec, now: () => clock, timers: again.timers });
  await restarted.resume();
  assert.equal(again.intervals.length, 1);
  assert.ok(again.calls.some(call => call[0] === 'osascript' && call[2] === 'quit app "Messages"'));
  const released = await restarted.release({});
  assert.deepEqual(released.released, ['a']);
  assert.ok(again.calls.some(call => call.join(' ') === 'shortcuts run Trillion Focus off'));
  const kept = JSON.parse(await readFile(join(home, settings.folder, 'holds.json'), 'utf8'));
  assert.deepEqual(kept.holds, []);
  assert.equal((await restarted.release({})).said, settings.words.nothing_held);
});

test('a Mac without the Focus shortcut gets it signed and opened, and the answer says the one press', async () => {
  const home = await mkdtemp(join(tmpdir(), 'trillion-hold-'));
  const mac = pretendMac({ shortcuts: [] });
  const holds = makeHolds({ settings, home, exec: mac.exec, now: () => Date.parse('2026-10-05T12:00:00Z'), timers: mac.timers });
  const answer = await holds.focus({ on: true });
  assert.equal(answer.switched, false);
  assert.equal(answer.said, settings.words.add_shortcut);
  assert.ok(mac.calls.some(call => call[0] === 'shortcuts' && call[1] === 'sign'));
  assert.ok(mac.calls.some(call => call[0] === 'open' && call[1].endsWith('Trillion Focus on.shortcut')));
  const plain = JSON.parse(await readFile(join(home, settings.folder, 'Trillion Focus on.json'), 'utf8'));
  assert.equal(plain.WFWorkflowActions[0].WFWorkflowActionParameters.Enabled, 1);
});

test('a hold naming only closes every other app, never the kept or always-open ones', async () => {
  const home = await mkdtemp(join(tmpdir(), 'trillion-hold-'));
  const mac = pretendMac();
  const holds = makeHolds({ settings, home, exec: mac.exec, now: () => Date.parse('2026-10-05T12:00:00Z'), timers: mac.timers });
  const held = await holds.hold({ id: 'one-thing', only: ['Slack'], minutes: 30, focus: false });
  assert.deepEqual(held.hold.only, ['Slack']);
  assert.deepEqual(held.closed, ['Messages']);
  assert.ok(!mac.calls.some(call => call.join(' ').includes('Finder') || call.join(' ').includes('"Slack"')));
  assert.match(held.said, /only Slack, Finder/);
  const closes = closedBy([{ apps: [], only: ['Slack'] }, { apps: ['Mail'] }], settings);
  assert.deepEqual(['Slack', 'Mail', 'Trillion', 'Notes'].map(closes), [false, true, false, true]);
});

// The apps the person's AIs run in, as they really run on a Mac: the Codex app inside ChatGPT.app, super.engineering
// whose executable is superconductor, Arc, Cursor, plus a call in a meeting app and a plain distraction.
const AGENT_MAC = [
  ' 1) "ChatGPT" ASN:0x0-0x1: ', '    bundleID="com.openai.codex"', '    bundle path="/Applications/ChatGPT.app"', '    executable path="/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"', '    pid = 1001 type="Foreground" flavor=3',
  ' 2) "superconductor" ASN:0x0-0x2: ', '    bundleID="com.zarifpour.superconductor"', '    bundle path="/Applications/super.engineering.app"', '    executable path="/Applications/super.engineering.app/Contents/MacOS/superconductor"', '    pid = 1002 type="Foreground" flavor=3',
  ' 3) "Arc" ASN:0x0-0x3: ', '    bundleID="company.thebrowser.Browser"', '    bundle path="/Applications/Arc.app"', '    executable path="/Applications/Arc.app/Contents/MacOS/Arc"', '    pid = 1003 type="Foreground" flavor=3',
  ' 4) "Cursor" ASN:0x0-0x4: ', '    bundle path="/Applications/Cursor.app"', '    pid = 1004 type="Foreground" flavor=3',
  ' 5) "zoom.us" ASN:0x0-0x5: ', '    bundle path="/Applications/zoom.us.app"', '    pid = 1005 type="Foreground" flavor=3',
  ' 6) "Netflix" ASN:0x0-0x6: ', '    bundle path="/Applications/Netflix.app"', '    pid = 1006 type="Foreground" flavor=3',
  ' 7) "Trillion" ASN:0x0-0x7: ', '    bundle path="/Applications/Trillion.app"', '    pid = 1007 type="Foreground" flavor=3',
].join('\n');
// The meeting app's audio helper (1105, child of 1005) holds the microphone; Trillion's listener holds it too.
const ASSERTIONS = [
  '   pid 428(coreaudiod): [0x1] 00:10:00 PreventUserIdleSystemSleep named: "com.apple.audio.BuiltInMicrophoneDevice.context.preventuseridlesleep"',
  '\tCreated for PID: 1105. ', '\tResources: audio-in BuiltInMicrophoneDevice ',
  '   pid 428(coreaudiod): [0x2] 00:10:00 PreventUserIdleSystemSleep named: "com.apple.audio.BuiltInSpeakerDevice.context.preventuseridlesleep"',
  '\tCreated for PID: 1006. ', '\tResources: audio-out BuiltInSpeakerDevice ',
  '   pid 357(powerd): [0x3] 51:27:30 PreventUserIdleSystemSleep named: "Powerd - Prevent sleep while display is on"',
].join('\n');
const PS = ['1 0', '1001 1', '1002 1', '1003 1', '1004 1', '1005 1', '1105 1005', '1006 1', '1007 1'].join('\n');

test('no hold ever closes the apps the AIs run in (found by kind), and a live call waits; the rest close', async () => {
  const rows = placeRows(settings);
  // What each installed bundle declares in its Info.plist, as on the person's Mac.
  const facts = path => ({ '/Applications/super.engineering.app': { executable: 'superconductor', bundle_id: 'com.zarifpour.superconductor' }, '/Applications/ChatGPT.app': {} }[path] ?? {});
  const kept = keptIdentities(settings, rows, '/work/sample', facts);
  for (const id of ['/applications/chatgpt.app', 'super.engineering', 'superconductor', 'com.zarifpour.superconductor', '/applications/arc.app', 'cursor', 'claude', 'terminal']) assert.ok(kept.has(id), id);
  assert.deepEqual([...pidsUsing(ASSERTIONS, settings.spare_while_using)], [1105]);
  assert.deepEqual([...appsUsing(runningApps(AGENT_MAC), new Set([1105]), PS)], [1005]);
  const home = await mkdtemp(join(tmpdir(), 'trillion-hold-'));
  const calls = [];
  let assertions = ASSERTIONS;
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'lsappinfo') return { ok: true, stdout: AGENT_MAC, stderr: '' };
    if (file === 'pmset') return { ok: true, stdout: assertions, stderr: '' };
    if (file === 'ps') return { ok: true, stdout: PS, stderr: '' };
    if (file === 'shortcuts') return { ok: true, stdout: 'Trillion Focus on\nTrillion Focus off', stderr: '' };
    return { ok: true, stdout: '', stderr: '' };
  };
  const timers = { setInterval: () => 1, clearInterval: () => {} };
  const holds = makeHolds({ settings, rows, home, facts, exec, now: () => Date.parse('2026-10-07T05:00:00Z'), timers });
  const held = await holds.hold({ id: 'needs-you-hold', only: ['Trillion'], minutes: 60 });
  assert.deepEqual(held.closed, ['Netflix']);
  assert.match(held.said, /super\.engineering/);
  // The call ends: the meeting app lets the microphone go and the next look closes it (the pretend Netflix reopens).
  assertions = '';
  assert.deepEqual(await holds.look(), ['zoom.us', 'Netflix']);
  // A hold naming an AI app by any of its names still never closes it.
  const named = await holds.hold({ id: 'named', apps: ['superconductor', 'ChatGPT', 'Arc', 'Netflix'], minutes: 30, focus: false });
  assert.deepEqual(named.closed, ['zoom.us', 'Netflix']);
  assert.deepEqual(named.hold.apps, ['Netflix'], 'the answer never says an AI app will close, by any of its names');
  assert.ok(!calls.some(call => call[0] === 'osascript' && /ChatGPT|superconductor|Arc|Cursor|Trillion/.test(call[2])));
});
