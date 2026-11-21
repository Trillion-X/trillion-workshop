// The awareness settings the owner keeps as DATA (src/awareness-settings.json: the scalar settings of the old app's
// src/awareness.json at b6ae0ebf8). The reading's schedule is computed from them without any model call: with a last reading two minutes
// old and every_minutes 5, the next reading is due three minutes from now.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readAwareness } from '../do-work/read-awareness.mjs';

const settings = JSON.parse(readFileSync(new URL('../src/awareness-settings.json', import.meta.url), 'utf8'));

test('the ported settings keep the old schedule and limits', () => {
  assert.equal(settings.every_minutes, 5);
  assert.equal(settings.readings_per_day, 288);
  assert.equal(settings.waiting_longest_minutes, 60);
  assert.equal(settings.kept.pursuits, 12);
  assert.equal(settings.inputs.chars, 1800);
});

test('next_due is the last reading plus every_minutes, computed with no model call', async () => {
  const now = Date.parse('2026-11-18T11:06:40.000Z');
  const { next_due } = await readAwareness({
    action: 'next_due', settings, now,
    state: { allowed: true, picture: null, pending: null, stated: [], unread: true,
      reading: { cursor: null, last_read_at: '2026-11-18T11:04:40.000Z', read_count: 3, day: '2026-11-18', today: 2 } },
  });
  assert.equal(next_due, '2026-11-18T11:09:40.000Z');
});
