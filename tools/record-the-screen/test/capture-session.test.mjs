// Screen recording as a helper process: the source, the capturer ladder, the verbs, the leave-out list, the pointer sidecar, the save, and the tool row a person's AI reaches it through (tools/record-the-screen/do-work/capture-session.mjs).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { capture, captureSettings, captureTools, makeCaptureSession, normalisePoint } from '../do-work/capture-session.mjs';

const settings = captureSettings();
const never = new Promise(() => {});
const wait = ms => (ms >= 10000 ? never : Promise.resolve());
const screen = { displays: [{ id: 1, x: 0, y: 0, width: 1000, height: 500 }], windows: [{ id: 42, app: 'Notes', title: 'Plan', x: 100, y: 50, width: 400, height: 300 }] };

/** A pretend machine: which programs exist, what each one does when run, and every command given to it. */
function machine({ programs = ['/usr/bin/swift', '/usr/sbin/screencapture'], failing = [], list = screen } = {}) {
  const world = { runs: [], shielded: 0, list, pointer: null, children: [] };
  const spawn = (program, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdin = { writes: [], write(text) { this.writes.push(text); if (text === 'stop\n') setImmediate(() => { child.stdout.emit('data', '{"event":"ended","reason":"stopped"}\n'); child.emit('exit', 0); }); } };
    child.signals = []; child.kill = signal => { child.signals.push(signal); if (signal === 'SIGINT' || signal === 'SIGTERM') setImmediate(() => child.emit('exit', 0)); };
    const script = args[0] ?? '';
    if (script.endsWith('track-pointer.swift')) { world.pointer = child; return child; }
    const config = script.endsWith('capture-display.swift') ? JSON.parse(args[1]) : null;
    const file = config ? config.file : args.at(-1);
    world.runs.push({ program, args, config, file, child });
    if (failing.includes(path.basename(script) || program)) setImmediate(() => child.emit('exit', 1));
    else { writeFileSync(file, 'movie'); if (config) setImmediate(() => child.stdout.emit('data', '{"event":"started"}\n')); }
    return child;
  };
  const session = home => makeCaptureSession({ settings, home, spawn, wait, watch: false, now: () => world.clock ?? Date.now(), sources: async () => world.list, has: row => programs.includes(row.program) && !(failing.includes('absent:' + row.id)), shield: async hold => { world.shielded += 1; await hold(); } });
  return { world, session };
}
// A pretend home outside the system folders recordings are never saved into (a Mac's own temp folder is under /var, so
// there it is /private/tmp; elsewhere the machine's temp folder is outside every refused root).
const homeOf = () => mkdtempSync(existsSync('/private/tmp') ? '/private/tmp/capture-home-' : path.join(os.tmpdir(), 'capture-home-'));

test('a recording needs a source that exists; the first capturer that can records it and its command carries the JSON config', async () => {
  const { world, session } = machine();
  const mine = session(homeOf());
  await assert.rejects(mine.start({}), /Say what to record: a display or a window/);
  await assert.rejects(mine.start({ source: { kind: 'window', id: 9 } }), { status: 404, message: /no window called 9/ });
  const started = await mine.start({ source: { kind: 'window', id: 42 } });
  assert.deepEqual([started.state, started.capturer, started.source], ['recording', 'screen-kit-helper', { kind: 'window', id: 42 }]);
  assert.deepEqual(world.runs[0].config.source, { kind: 'window', id: '42', frame: { x: 100, y: 50, width: 400, height: 300 } });
  assert.equal(world.runs[0].config.fps, 30);
  await assert.rejects(mine.start({ source: { kind: 'display', id: 1 } }), { status: 409, message: /already running/ });
  assert.equal(statSync(path.dirname(started.file)).mode & 0o777, 0o700);
  await mine.stop();
});

test('pause and resume reach the helper by its stdin verbs, stop ends it with the reason, and a capturer without a verb refuses it in words', async () => {
  const { world, session } = machine({ failing: ['capture-display.swift'] });
  const mine = session(homeOf());
  // The helper fails to start, so the next capturer (screencapture) takes over and has no pause verb.
  const started = await mine.start({ source: { kind: 'display', id: 1 } });
  assert.equal(started.capturer, 'screencapture');
  assert.deepEqual(world.runs.map(run => path.basename(run.args[0])), ['capture-display.swift', '-v']);
  assert.ok(world.runs[1].args.includes('-D1'));
  await assert.rejects(mine.pause(), { status: 409, message: /screencapture cannot pause/ });
  const stopped = await mine.stop();
  assert.deepEqual([stopped.state, stopped.reason], ['ended', 'stopped']);
  assert.deepEqual(world.runs[1].child.signals, ['SIGINT']);
  assert.equal(statSync(stopped.file).mode & 0o777, 0o600);

  const second = machine();
  const helper = second.session(homeOf());
  await helper.start({ source: { kind: 'display', id: 1 } });
  assert.equal((await helper.pause()).state, 'paused');
  assert.equal((await helper.resume()).state, 'recording');
  assert.deepEqual(second.world.runs[0].child.stdin.writes, ['pause\n', 'resume\n']);
  await assert.rejects(helper.resume(), { status: 409 });
  await helper.stop();
  await assert.rejects(helper.stop(), /No recording is running/);
});

test('the leave-out list is kept in the person\'s file and only a capturer that can leave things out records; with none, it is refused in words', async () => {
  const home = homeOf();
  const { world, session } = machine({ programs: ['/usr/sbin/screencapture'] });
  const mine = session(home);
  assert.deepEqual(mine.exclude({ what: 'app', value: 'com.apple.Notes' }).apps, ['com.apple.Notes']);
  assert.deepEqual(mine.exclude({ what: 'title', value: 'Passwords' }).titles, ['Passwords']);
  assert.equal(JSON.parse(readFileSync(path.join(home, '.trillion/capture/session-prefs.json'), 'utf8')).exclude.apps[0], 'com.apple.Notes');
  await assert.rejects(mine.start({ source: { kind: 'display', id: 1 } }), { status: 409, message: /screencapture cannot leave out the apps and windows you listed \(com.apple.Notes, Passwords\)/ });
  mine.exclude({ what: 'app', value: 'com.apple.Notes', on: false }); mine.exclude({ what: 'title', value: 'Passwords', on: false });
  assert.equal((await mine.start({ source: { kind: 'display', id: 1 } })).capturer, 'screencapture');
  assert.equal(world.runs.length, 1);
  await mine.stop();
  const withHelper = machine().session(home);
  withHelper.exclude({ what: 'title', value: 'Passwords' });
  const world2 = machine();
  const again = world2.session(home);
  await again.start({ source: { kind: 'display', id: 1 } });
  assert.deepEqual(world2.world.runs[0].config.exclude, { apps: [], titles: ['Passwords'] });
  await again.stop();
  assert.throws(() => mine.exclude({ what: 'other' }), /app or a window title/);
});

test('the app\'s own windows are hidden from the picture unless the person turns that off', async () => {
  const home = homeOf();
  const on = machine(); const onSession = on.session(home);
  await onSession.start({ source: { kind: 'display', id: 1 } }); await onSession.stop();
  assert.equal(on.world.shielded, 1);
  const off = machine(); const offSession = off.session(home);
  assert.equal(offSession.prefs({ name: 'hide_own_windows', value: false }).hide_own_windows, false);
  await offSession.start({ source: { kind: 'display', id: 1 } }); await offSession.stop();
  assert.equal(off.world.shielded, 0);
  assert.throws(() => offSession.prefs({ name: 'nope', value: 1 }), /no setting nope/);
});

test('a recording ends by itself, saying so, when its source goes away', async () => {
  const { world, session } = machine();
  const mine = session(homeOf());
  await mine.start({ source: { kind: 'window', id: 42 } });
  await mine.tick();
  assert.equal(mine.status().state, 'recording');
  world.list = { displays: screen.displays, windows: [] };
  await mine.tick();
  assert.deepEqual([mine.status().state, mine.status().reason], ['ended', 'The window being recorded went away, so the recording ended.']);
  assert.ok(world.runs[0].child.stdin.writes.includes('stop\n'));
});

test('the pointer is noted as positions and presses in the source frame, dropped outside it and while paused, and the sidecar is written beside the recording', async () => {
  assert.deepEqual(normalisePoint({ x: 100, y: 50, width: 400, height: 300 }, { x: 300, y: 200 }), { x: 0.5, y: 0.5 });
  assert.equal(normalisePoint({ x: 100, y: 50, width: 400, height: 300 }, { x: 50, y: 200 }), null);
  const { world, session } = machine();
  let clock = 10_000; world.clock = clock;
  const mine = session(homeOf());
  await mine.start({ source: { kind: 'window', id: 42 } });
  const sample = (x, y, down = false, at = clock) => { world.clock = at; world.pointer.stdout.emit('data', `${JSON.stringify({ x, y, down })}\n`); };
  sample(300, 200, false, 10_100);
  sample(300, 200, false, 10_150);
  sample(300, 200, true, 10_200);
  sample(10, 10, false, 10_250);
  await mine.pause(); world.clock = 10_300;
  sample(320, 210, false, 10_300);
  world.clock = 11_300; await mine.resume();
  sample(340, 230, false, 11_400);
  const stopped = await mine.stop();
  const sidecar = JSON.parse(readFileSync(`${stopped.file}.pointer.json`, 'utf8'));
  assert.equal(sidecar.space, 'normalized-source');
  assert.deepEqual(sidecar.samples.map(row => row.type), ['move', 'click', 'move']);
  assert.deepEqual(sidecar.samples.map(row => row.t), [100, 200, 350]);
});

test('save moves the recording and its pointer note only under the allow-list, never through a link or over a file', async () => {
  const home = homeOf();
  mkdirSync(path.join(home, 'Movies'), { recursive: true }); mkdirSync(path.join(home, '.ssh'), { recursive: true }); mkdirSync(path.join(home, 'Elsewhere'), { recursive: true });
  const { session } = machine();
  const mine = session(home);
  assert.throws(() => mine.save({}), /nothing recorded to save/);
  await mine.start({ source: { kind: 'display', id: 1 } });
  const stopped = await mine.stop();
  writeFileSync(`${stopped.file}.pointer.json`, '{"space":"normalized-source","samples":[]}');
  assert.throws(() => mine.save({ destination: path.join(home, 'Elsewhere/a.mov') }), { status: 403, message: /not under a place recordings may be saved/ });
  assert.throws(() => mine.save({ destination: path.join(home, '.ssh/a.mov') }), { status: 403, message: /never saved/ });
  assert.throws(() => mine.save({ destination: path.join(home, 'Movies/a.txt') }), /saved as one of/);
  symlinkSync(path.join(home, 'Elsewhere'), path.join(home, 'Movies/out'));
  assert.throws(() => mine.save({ destination: path.join(home, 'Movies/out/a.mov') }), { status: 403 });
  writeFileSync(path.join(home, 'Movies/taken.mov'), 'x');
  assert.throws(() => mine.save({ destination: path.join(home, 'Movies/taken.mov') }), { status: 409, message: /already exists/ });
  const saved = mine.save({ destination: path.join(home, 'Movies/plan.mov') });
  assert.equal(readFileSync(saved.saved, 'utf8'), 'movie');
  assert.ok(existsSync(saved.pointer));
  assert.equal(existsSync(stopped.file), false);
  assert.throws(() => mine.save({ destination: path.join(home, 'Movies/plan2.mov') }), /nothing recorded to save|ENOENT/);
});

test('through the tool a person\'s AI uses: the tool row runs the capture export, and status with nothing recorded is idle', async () => {
  const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(row => row.payload);
  const row = rows.find(one => one.id === 'tool:record-the-screen');
  assert.deepEqual(row.invoke.argv.slice(-2), ['/opt/record-the-screen/do-work/capture-session.mjs', 'capture']);
  assert.equal(typeof captureTools.capture, 'function');
  assert.deepEqual(await capture({ action: 'status' }), { state: 'idle' });
});
