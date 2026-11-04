// The window of chunks in flight to one person's namespace (parts/live-namespace/do-work/send-window.mjs): it opens
// while the service takes chunks, halves the moment it answers busy, and never lets more than its size go at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { outcomeOf, sendWindow, windowOf, windowRules } from '../do-work/send-window.mjs';
import sendSettings from '../send-settings.json' with { type: 'json' };

const rules = { start: 4, least: 1, most: 8, busy_statuses: [429] };

test('the window opens by one after each round the service took, up to its most', async () => {
  const window = sendWindow(rules);
  assert.equal(window.size(), 4);
  for (let round = 0; round < 4; round += 1) { await window.take(); window.give('ok'); }
  assert.equal(window.size(), 5, 'one round of 4 taken opens it by one');
  for (let round = 0; round < 200; round += 1) { await window.take(); window.give('ok'); }
  assert.equal(window.size(), 8, 'never past most');
});

test('a busy answer halves it, never below least, and it never lets more than its size go at once', async () => {
  const window = sendWindow(rules);
  const held = [];
  for (let n = 0; n < 6; n += 1) held.push(window.take().then(() => n));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(window.running(), 4, 'two wait while four are in flight');
  window.give('busy');
  assert.equal(window.size(), 2);
  assert.equal(window.running(), 3, 'a place given back while over the new size lets nobody in');
  window.give('busy');
  window.give('busy');
  assert.equal(window.size(), 1);
  assert.equal(window.running(), 1);
  window.give('done');
  await Promise.all(held.slice(0, 5));
  assert.equal(window.running(), 1, 'the waiting go one at a time');
});

test('what an answer says: busy statuses, any 5xx and no answer close it; 2xx opens it; other answers do neither', () => {
  const read = windowRules(rules);
  assert.equal(outcomeOf(429, read), 'busy');
  assert.equal(outcomeOf(503, read), 'busy');
  assert.equal(outcomeOf(null, read), 'busy');
  assert.equal(outcomeOf(201, read), 'ok');
  assert.equal(outcomeOf(409, read), 'done');
});

test('every file sent through one client shares that client\'s one window, from the shared settings', () => {
  const client = {};
  assert.equal(windowOf(client, sendSettings.in_flight_per_person), windowOf(client, sendSettings.in_flight_per_person));
  assert.notEqual(windowOf(client, sendSettings.in_flight_per_person), windowOf({}, sendSettings.in_flight_per_person));
  assert.equal(windowOf({}, sendSettings.in_flight_per_person).size(), sendSettings.in_flight_per_person.start);
});
