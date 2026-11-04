// The Mac watch tells the person's AIs once when a process outgrows its row, again only after it grew more, and once
// when it is back under (computer/watch-this-mac.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryOf, reportsFor, startWatching, watchSettings } from '../watch-this-mac.mjs';

const topSaying = gb => `Processes: 470 total\nPID    COMMAND        MEM\n436    coreaudiod     ${gb}\n698    superconductor 7327M\n77     tiny           512K\n`;

test('top\'s memory column is read in GB, whatever unit it uses', () => {
  const memory = memoryOf(topSaying('39G'));
  assert.equal(memory.coreaudiod, 39);
  assert.ok(Math.abs(memory.superconductor - 7327 / 1024) < 1e-9);
  assert.ok(memory.tiny < 0.001);
});

test('the sound server is told once when it outgrows its row, again only after it grew more, and once when it is back', async () => {
  const settings = watchSettings();
  const row = settings.watch.find(item => item.process === 'coreaudiod');
  assert.ok(row, 'coreaudiod is a row');
  const sent = [];
  let reading = `${row.most_gb + 1}G`;
  const watch = startWatching({ settings, post: async report => { sent.push(report); return true; }, read: async () => topSaying(reading), computer: 'Mac', timers: false });
  await watch.tick();
  await watch.tick();
  assert.equal(sent.length, 1, 'a steady reading is one notice');
  assert.equal(sent[0].state, 'failed');
  assert.equal(sent[0].kind, row.kind);
  assert.match(sent[0].title, new RegExp(`${row.most_gb + 1}\\.0 GB`));
  assert.match(sent[0].body, /sudo killall coreaudiod/);
  reading = `${row.most_gb + 1 + row.again_gb}G`;
  await watch.tick();
  assert.equal(sent.length, 2, 'told again once it grew again_gb more');
  assert.equal(sent[1].key, sent[0].key, 'the same notice changes');
  reading = '300M';
  await watch.tick();
  await watch.tick();
  assert.equal(sent.length, 3);
  assert.equal(sent[2].state, 'done');
});

test('a report the account does not take is tried again on the next look; nothing is told for a process top does not list', async () => {
  const settings = watchSettings();
  const row = settings.watch[0];
  let take = false;
  const sent = [];
  const watch = startWatching({ settings, post: async report => { sent.push(report); return take; }, read: async () => topSaying(`${row.most_gb + 1}G`), computer: 'Mac', timers: false });
  await watch.tick();
  take = true;
  await watch.tick();
  await watch.tick();
  assert.equal(sent.length, 2);
  assert.deepEqual(reportsFor(settings, {}, new Map(), 'Mac'), []);
});
