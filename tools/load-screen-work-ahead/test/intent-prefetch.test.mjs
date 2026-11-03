// test/intent-prefetch.test.mjs
// The shared prefetch-on-intent primitive (parts/ui/show/intent-prefetch): the pointer's path predicts the one target
// it is heading for, which is started with an abort signal aborted when the path turns away; ambiguous paths, touch and
// save-data devices start nothing; each open reports how long ahead of it the start was made. Bundled as the page has it.
import test from 'node:test';
import assert from 'node:assert/strict';
const intent = await import('../parts/ui/show/intent-prefetch/intent-prefetch.ts');

const box = (left, top, right, bottom) => ({ left, top, right, bottom });
const rows = [{ key: 'files', box: box(0, 0, 200, 30) }, { key: 'lists', box: box(0, 40, 200, 70) }, { key: 'home', box: box(0, 80, 200, 110) }];

test('the path predicts the one row the pointer is heading for; the row under it wins; several crossed start none', () => {
  // Moving straight down at 1 px/ms from above the list, aimed at "lists" only within the look-ahead.
  const down = [{ x: 100, y: -220, at: 0 }, { x: 100, y: -170, at: 50 }, { x: 100, y: -120, at: 100 }];
  assert.equal(intent.intendedTarget(down, rows.slice(1)), 'lists', 'the only row the predicted path crosses');
  assert.equal(intent.intendedTarget(down, rows), null, 'a path crossing several rows is ambiguous');
  assert.equal(intent.intendedTarget([{ x: 50, y: 50, at: 0 }], rows), 'lists', 'the row under the pointer');
  assert.equal(intent.intendedTarget([{ x: 300, y: 10, at: 0 }, { x: 300.5, y: 10, at: 100 }], rows), null, 'a pointer at rest beside the rows heads nowhere');
  assert.equal(intent.crosses({ x: 0, y: 0 }, { x: 10, y: 10 }, box(20, 20, 30, 30)), false);
  assert.equal(intent.crosses({ x: 0, y: 25 }, { x: 40, y: 25 }, box(20, 20, 30, 30)), true);
});

test('nothing is started ahead on save-data, slow connections or small devices', () => {
  assert.equal(intent.intentOff({ connection: { saveData: true } }), 'save-data');
  assert.equal(intent.intentOff({ connection: { effectiveType: '2g' } }), 'slow-connection');
  assert.equal(intent.intentOff({ deviceMemory: 1 }), 'small-device');
  assert.equal(intent.intentOff({ connection: { effectiveType: '4g' }, deviceMemory: 8 }), null);
});

test('one start at a time, aborted when the path turns away or leaves; opens report how long ahead they were started', () => {
  const listeners = {};
  const root = { addEventListener: (type, run) => { listeners[type] = run; }, removeEventListener: type => { delete listeners[type]; } };
  const elements = rows.map(row => ({ key: row.key, getBoundingClientRect: () => row.box }));
  const frames = [];
  globalThis.requestAnimationFrame = run => { frames.push(run); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  let clock = 0;
  const started = [];
  const watcher = intent.watchIntent(root, { targets: () => elements, keyOf: element => element.key, start: (key, { signal }) => started.push({ key, signal }), device: {}, now: () => clock });
  const move = (x, y, pointerType = 'mouse') => { listeners.pointermove({ clientX: x, clientY: y, pointerType }); for (const run of frames.splice(0)) run(); };
  move(50, 15, 'touch');
  assert.equal(started.length, 0, 'touch has no path before the tap');
  move(50, 15);
  assert.deepEqual(started.map(one => one.key), ['files']);
  clock = 30; move(50, 55);
  assert.deepEqual(started.map(one => one.key), ['files', 'lists']);
  assert.equal(started[0].signal.aborted, true, 'the start the path turned away from is aborted');
  clock = 30; move(50, 56);
  assert.equal(started.length, 2, 'the same target is not started twice');
  clock = 250; watcher.opened('lists'); watcher.opened('home');
  assert.deepEqual(watcher.timings(), { opened: 2, started_ahead: 1, median_ahead_ms: 220 });
  listeners.pointerleave();
  assert.equal(started[1].signal.aborted, true, 'leaving the root aborts the live start');
  watcher.stop();
  assert.equal(listeners.pointermove, undefined);
  const saving = intent.watchIntent(root, { targets: () => elements, keyOf: element => element.key, start: () => assert.fail('nothing starts on save-data'), device: { connection: { saveData: true } } });
  assert.equal(saving.off, 'save-data');
});
