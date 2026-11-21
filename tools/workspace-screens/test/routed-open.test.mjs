// The address the page is opened at opens its screen, once the arrangement takes it: a screen a catalogue read offers
// later still opens, and an address that names no screen opens nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openRouted, routedRequests } from '../web/src/workspace/routed-open.mjs';

const offered = [
  { id: 'screen.record', route_paths: ['/record'] },
  { id: 'waiting-on-your-yes', route_paths: ['/waiting-on-your-yes'], surface_input: { view: 'waiting' } },
];

/** A clock and a queue of later tries, run by the test: `run` plays them until none is left or the clock passes `until`. */
function scheduler() {
  let time = 0;
  const queue = [];
  return {
    now: () => time,
    later: fn => queue.push(fn),
    run(until = 1e9) {
      while (queue.length && time < until) { time += 250; const next = queue.shift(); next(); }
    },
  };
}

test('the screen an address names is the request the arrangement is asked for', () => {
  assert.deepEqual(routedRequests(offered, '/record').map(request => request.id), ['screen.record']);
  assert.deepEqual(routedRequests(offered, '/waiting-on-your-yes'), [{ id: 'waiting-on-your-yes', surfaceInput: { view: 'waiting' } }]);
});

test('an address that names no screen, or the workspace root, asks for nothing', () => {
  assert.deepEqual(routedRequests(offered, '/workspace'), []);
  assert.deepEqual(routedRequests(offered, '/no-such-screen'), []);
});

test('the request is asked again until the arrangement takes it, however many tries that is', () => {
  const clock = scheduler();
  const asked = [];
  const open = request => { asked.push(request.id); return asked.length >= 40; };
  openRouted(() => routedRequests(offered, '/waiting-on-your-yes'), open, () => true, { ...clock, waitMs: 1e9 });
  clock.run();
  assert.equal(asked.length, 40, 'a frame count would have stopped at 300 frames');
});

test('a screen the catalogue offers only later still opens at its address', () => {
  const clock = scheduler();
  let catalogue = [];
  const opened = [];
  const open = request => { opened.push(request.id); return true; };
  openRouted(() => routedRequests([...offered, ...catalogue], '/use/later-tool'), open, () => catalogue.length > 0, clock);
  clock.run(1000);
  assert.deepEqual(opened, []);
  catalogue = [{ id: 'tool:later', route_paths: ['/use/later-tool'] }];
  clock.run();
  assert.deepEqual(opened, ['tool:later']);
});

test('once the page has settled, an address whose screen never arrives stops at once and opens nothing', () => {
  const clock = scheduler();
  const open = () => { throw new Error('nothing to open'); };
  openRouted(() => routedRequests(offered, '/workspace'), open, () => true, clock);
  assert.equal(clock.run(), undefined);
});

test('a screen the arrangement never takes is given up after the wait, so the page does not poll for ever', () => {
  const clock = scheduler();
  let tries = 0;
  openRouted(() => routedRequests(offered, '/record'), () => { tries += 1; return false; }, () => false, { ...clock, waitMs: 5000 });
  clock.run();
  assert.ok(tries > 0 && tries <= 25, `gave up after ${tries} tries`);
});
