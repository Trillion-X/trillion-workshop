// src/workspace/messages-turns.test.ts
//
// Run: node --test tools/messages-screen/web/src/workspace/messages-turns.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysOf, timeOfText } from './messages-turns.ts';
import type { Line } from './chat-records.ts';

const words = { today: 'Today', yesterday: 'Yesterday' };
const at = (year: number, month: number, day: number, hour: number, minute: number) => new Date(year, month, day, hour, minute);
const line = (atomRef: string, when: Date, role: 'human' | 'assistant', author?: string): Line => ({
  type: 'text', role, atomRef, content: atomRef, timestamp: when.toISOString(), ...(author ? { author } : {}),
});

test('a stored time reads in both its own text form and ISO', () => {
  assert.equal(timeOfText('2026-11-20 16:59:07.381+00'), Date.parse('2026-11-20T16:59:07.381Z'));
  assert.equal(timeOfText('2026-11-13T08:33:30.000Z'), Date.parse('2026-11-13T08:33:30.000Z'));
  assert.ok(Number.isNaN(timeOfText('not a time')));
});

test('one side in a row within ten minutes is one turn; a side change starts a new turn', () => {
  const now = at(2026, 10, 21, 12, 0);
  const days = daysOf([
    line('a', at(2026, 10, 20, 9, 0), 'assistant', 'Sam'),
    line('b', at(2026, 10, 20, 9, 4), 'assistant', 'Sam'),
    line('c', at(2026, 10, 20, 9, 5), 'human'),
    line('d', at(2026, 10, 20, 9, 6), 'assistant', 'Sam'),
  ], now, words);
  assert.equal(days.length, 1);
  assert.deepEqual(days[0].turns.map(turn => turn.lines.map(one => one.atomRef)), [['a', 'b'], ['c'], ['d']]);
  assert.deepEqual(days[0].turns.map(turn => turn.mine), [false, true, false]);
});

test('a gap of more than ten minutes or a new author starts a new turn', () => {
  const now = at(2026, 10, 21, 12, 0);
  const days = daysOf([
    line('a', at(2026, 10, 20, 9, 0), 'assistant', 'Sam'),
    line('b', at(2026, 10, 20, 9, 11), 'assistant', 'Sam'),
    line('c', at(2026, 10, 20, 9, 12), 'assistant', 'Priya'),
  ], now, words);
  assert.deepEqual(days[0].turns.map(turn => turn.lines.map(one => one.atomRef)), [['a'], ['b'], ['c']]);
  assert.deepEqual(days[0].turns.map(turn => turn.author), ['Sam', 'Sam', 'Priya']);
});

test('each day is its own group, labelled today, yesterday, then its date', () => {
  const now = at(2026, 10, 21, 12, 0);
  const days = daysOf([
    line('old', at(2026, 10, 18, 9, 0), 'assistant'),
    line('yesterday', at(2026, 10, 20, 9, 0), 'human'),
    line('today', at(2026, 10, 21, 9, 0), 'human'),
  ], now, words);
  assert.equal(days[1].label, 'Yesterday');
  assert.equal(days[2].label, 'Today');
  assert.equal(days.length, 3);
});

test('a line with no readable time still shows, under an unlabelled day', () => {
  const days = daysOf([{ ...line('x', at(2026, 10, 20, 9, 0), 'assistant'), timestamp: 'garbled' }], at(2026, 10, 21, 12, 0), words);
  assert.equal(days.length, 1);
  assert.equal(days[0].label, '');
  assert.equal(days[0].turns[0].lines[0].atomRef, 'x');
});
