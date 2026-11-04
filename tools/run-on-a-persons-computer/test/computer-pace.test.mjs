import test from 'node:test';
import assert from 'node:assert/strict';
import { multiplierFor, pacedEvery, senseState } from '../pace.mjs';
import sources from '../../bring-in-new-items-from-this-computer/computer/computer-sources.json' with { type: 'json' };

const { pace } = sources;
const PMSET_BATTERY = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging; 3:10 remaining present: true\n";
const PMSET_AC = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n";
const ioreg = nanoseconds => `    | |   "HIDIdleTime" = ${nanoseconds}\n`;
const answers = (power, idle) => command => (command[0].endsWith('pmset') ? power : idle);

test('the sensed state follows the DATA rows: power by name, idleness by a threshold', async () => {
  assert.deepEqual(await senseState(pace.sense, answers(PMSET_BATTERY, ioreg(400_000_000_000))), { power: 'battery', idle: true });
  assert.deepEqual(await senseState(pace.sense, answers(PMSET_AC, ioreg(150_499_208))), { power: 'ac', idle: false });
});

test('a state that cannot be sensed is left out, so the pace never slows on a guess', async () => {
  const run = command => { if (command[0].endsWith('pmset')) throw new Error('no pmset'); return 'nothing like it'; };
  assert.deepEqual(await senseState(pace.sense, run), {});
  assert.equal(multiplierFor({}, pace.rows), 1);
  assert.equal(multiplierFor({ idle: true }, pace.rows), 2, 'an unknown power state does not stop an idle one from slowing it');
});

test('the first matching row sets the multiplier', () => {
  assert.equal(multiplierFor({ power: 'battery', idle: true }, pace.rows), 4);
  assert.equal(multiplierFor({ power: 'battery', idle: false }, pace.rows), 2);
  assert.equal(multiplierFor({ power: 'ac', idle: false }, pace.rows), 1);
});

test('a paced look waits base x multiplier, follows a change of state and senses at most once a window', async () => {
  const waits = [];
  let fire = null, clock = 0, sensedTimes = 0, state = { power: 'ac', idle: false };
  const timers = { set: (fn, ms) => { fire = fn; waits.push(ms); return waits.length; }, clear: () => { fire = null; } };
  const looks = [];
  const paced = pacedEvery(async () => looks.push(clock), 30, pace, { senseNow: async () => { sensedTimes += 1; return state; }, timers, now: () => clock });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(waits, [30_000]);
  clock = 60_000; state = { power: 'battery', idle: true };
  await fire();
  assert.deepEqual(waits, [30_000, 120_000], 'a change sensed once the sensing window has passed shows in the very next wait');
  clock = 90_000; state = { power: 'ac', idle: false };
  await fire();
  assert.deepEqual(waits, [30_000, 120_000, 120_000], 'within the sensing window the state is not sensed again');
  assert.equal(sensedTimes, 2);
  console.log('PACE READBACK waits (ms):', JSON.stringify(waits), 'looks:', looks.length);
  paced.stop();
  assert.equal(fire, null);
});

test('this computer: the real sensing commands answer and give a multiplier', async () => {
  const state = await senseState(pace.sense);
  console.log('PACE READBACK this Mac:', JSON.stringify(state), 'multiplier', multiplierFor(state, pace.rows));
  assert.ok(['battery', 'ac'].includes(state.power) && typeof state.idle === 'boolean');
});
