// test/instant-screens.test.mjs
//
// The screen a person's words pick as they type (src/instant-screens.mjs) and the values those words give its inputs
// (src/input-parsers.mjs): picked on the device with no model, from an open catalog (every offered screen, every made
// interface by its intent, every kept screen by its words); calm (a challenger must win twice); bounded; and better
// every time an AI saves a screen with the words that asked for it. Also the owners it reads and writes through:
// made-controls `list` (POST /controls/list) and the Workshop's screen rows carrying `asked`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fillInputs, parserOf } from '../src/input-parsers.mjs';
import { createAnswers, keepAsk, keptAsks, removeAsk, renameAsk, INSTANT_SCREENS } from '../src/instant-screens.mjs';
// Ported from Trillion-X/trillion test/instant-screens.test.mjs: the cases over the two moved modules alone. The cases that rank
// the app's own screen catalog (src/workspace/screens.mjs), made-controls and the Workshop screen rows stay with the old tree.

// Tuesday 20 October 2026, 2:05 PM on the device.
const NOW = new Date(2026, 9, 20, 14, 5);
const fill = (properties, words, extra = {}) => fillInputs({ properties }, words, { now: NOW, ...extra }).values;

test('one parser registry fills any schema from its own format, enum, type or x-parse, with no model', () => {
  assert.equal(parserOf({ type: 'string', format: 'date-time' }), 'datetime');
  assert.equal(parserOf({ type: 'number' }, 'minutes'), 'duration', 'a number named after a unit of time holds a duration');
  assert.equal(parserOf({ type: 'number' }, 'width'), 'number');
  assert.equal(parserOf({ enum: ['a', 'b'] }), 'choice');
  assert.equal(parserOf({ type: 'string', 'x-parse': 'person' }), 'person');
  assert.equal(parserOf({ type: 'string' }), 'rest');
  assert.deepEqual(fill({ seconds: { type: 'number' } }, 'timer 25 min'), { seconds: 1500 });
  assert.deepEqual(fill({ minutes: { type: 'integer' } }, 'focus 1 hour 30 minutes'), { minutes: 90 });
  assert.deepEqual(fill({ length: { type: 'string', format: 'duration' } }, 'pomodoro 25m'), { length: 'PT1500S' });
  assert.deepEqual(fill({ when: { type: 'string', format: 'date-time' }, with: { type: 'string', 'x-parse': 'person' }, title: { type: 'string' } }, 'lunch with Ruth tomorrow at 1'),
    { when: '2026-10-21T13:00:00' + offset(new Date(2026, 9, 21, 13)), with: 'Ruth', title: 'lunch' });
  assert.deepEqual(fill({ due: { type: 'string', format: 'date' }, text: { type: 'string' } }, 'remind me to call Sam friday'), { due: '2026-10-23', text: 'call Sam' });
  assert.deepEqual(fill({ day: { type: 'string', format: 'date' } }, 'oct 24'), { day: '2026-10-24' });
  assert.deepEqual(fill({ day: { type: 'string', format: 'date' } }, '24th of march'), { day: '2027-03-24' }, 'a day gone this year is next year\'s');
  assert.deepEqual(fill({ day: { type: 'string', format: 'date' } }, 'in 3 days'), { day: '2026-10-23' });
  assert.deepEqual(fill({ at: { type: 'string', format: 'time' } }, 'standup 9:30am'), { at: '09:30' });
  assert.deepEqual(fill({ when: { type: 'string', format: 'date-time' } }, 'in 20 minutes'), { when: '2026-10-20T14:25:00' + offset(NOW) });
  assert.deepEqual(fill({ amount: { type: 'number', 'x-parse': 'amount' }, note: { type: 'string' } }, 'coffee $4.50'), { amount: 4.5, note: 'coffee' });
  assert.deepEqual(fill({ amount: { type: 'number' } }, 'rent 12k'), { amount: 12000 });
  assert.deepEqual(fill({ width: { type: 'integer' }, height: { type: 'integer' } }, 'resize height 200 width 300'), { width: 300, height: 200 }, 'each number goes to the input named before it');
  assert.deepEqual(fill({ tone: { enum: ['warm', 'cool'] } }, 'make it warmer'), { tone: 'warm' });
  assert.deepEqual(fill({ tone: { enum: ['warm', 'cool'] } }, 'make it bluer', { choices: { tone: [{ value: 'cool', label: 'Bluer' }] } }), { tone: 'cool' }, 'a choice is found by its label too');
  assert.deepEqual(fill({ captions: { type: 'boolean' } }, 'video without captions'), { captions: false });
  assert.deepEqual(fill({ to: { type: 'string', format: 'email' } }, 'send to sam@example.com'), { to: 'sam@example.com' });
  assert.deepEqual(fill({ count: { type: 'integer', minimum: 1, maximum: 10 } }, 'give me 3 choices for dinner'), { count: 3 });
  assert.deepEqual(fill({ count: { type: 'integer', minimum: 1, maximum: 10 } }, 'give me 30 choices'), {}, 'a value the schema refuses is left for the person');
  assert.deepEqual(fill({ a: { type: 'string' }, b: { type: 'string' } }, 'some words'), {}, 'with two text inputs nobody can know which takes the words');
  assert.deepEqual(fillInputs({ properties: { note: { type: 'string' } } }, 'timer buy milk', { used: [[0, 5]] }).values, { note: 'buy milk' }, 'the words that picked the screen are not a value');
});

function offset(date) {
  const minutes = -date.getTimezoneOffset();
  const pad = number => String(number).padStart(2, '0');
  return `${minutes >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
}


test('answers are bounded and the least recently used is let go first', () => {
  const answers = createAnswers(2);
  answers.set('a', 1); answers.set('b', 2);
  assert.equal(answers.get('a'), 1);
  answers.set('c', 3);
  assert.equal(answers.get('b'), undefined);
  assert.equal(answers.get('a'), 1);
  assert.equal(answers.size, 2);
});

test('kept screens: keep, keep again, rename and remove, each bounded and well formed', () => {
  let asks = keepAsk(null, { words: 'timer 25 min', screen: 'tool:focus-timer', input: { filled_inputs: { seconds: 1500 } }, label: 'Focus timer' }, 'id-1', NOW);
  asks = keepAsk(asks, { words: 'Timer 25 min', screen: 'tool:focus-timer', input: { filled_inputs: { seconds: 1500 } } }, 'id-2', NOW);
  assert.equal(keptAsks(asks).length, 1, 'the same words for the same screen are one kept screen');
  assert.equal(keptAsks(asks)[0].id, 'id-1');
  asks = renameAsk(asks, 'id-1', 'Pomodoro');
  assert.equal(keptAsks(asks)[0].label, 'Pomodoro');
  assert.throws(() => renameAsk(asks, 'gone', 'x'), /not there/);
  assert.throws(() => keepAsk(asks, { words: ' ', screen: 'x' }, 'id-3'), /needs its words/);
  assert.deepEqual(keptAsks(removeAsk(asks, 'id-1')), []);
  let many = null;
  for (let index = 0; index < INSTANT_SCREENS.asks.max + 5; index += 1) many = keepAsk(many, { words: `ask ${index}`, screen: 'trillion.calendar' }, `id-${index}`, NOW);
  assert.equal(keptAsks(many).length, INSTANT_SCREENS.asks.max);
  assert.equal(keptAsks(many)[0].words, `ask ${INSTANT_SCREENS.asks.max + 4}`, 'newest first');
  assert.equal(keepAsk(null, { words: 'w'.repeat(500), screen: 's' }, 'long', NOW).asks[0].words.length, INSTANT_SCREENS.asks.words_max);
});

