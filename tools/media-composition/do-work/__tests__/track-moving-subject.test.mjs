/**
 * file: packages/media-composition/do-work/__tests__/track-moving-subject.test.mjs
 *
 * Tests centreOfChange: with two things moving, the centre is on ONE of them (never the empty space between), the
 * one with the most change is chosen first, and a subject already being followed keeps being followed while it moves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centreOfChange } from '../track-moving-subject.mjs';

const COLUMNS = 40;
const ROWS = 20;
/** A difference frame with a square of `value` cells centred on each (column, row). */
function frame(blobs) {
  const cells = new Uint8Array(COLUMNS * ROWS);
  for (const { column, row, value } of blobs) {
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) cells[(row + dy) * COLUMNS + column + dx] = value;
  }
  return cells;
}
const near = (actual, expected) => Math.abs(actual - expected) < 0.02;

test('two movers: the centre is on the one with the most change, not between them', () => {
  const centre = centreOfChange(frame([{ column: 8, row: 10, value: 200 }, { column: 32, row: 10, value: 120 }]), COLUMNS, ROWS);
  assert.ok(near(centre.x, 8.5 / COLUMNS) && near(centre.y, 10.5 / ROWS), JSON.stringify(centre));
});

test('a subject being followed keeps being followed while it holds a fair share of the change', () => {
  const both = frame([{ column: 8, row: 10, value: 200 }, { column: 32, row: 10, value: 120 }]);
  const kept = centreOfChange(both, COLUMNS, ROWS, { x: 32.5 / COLUMNS, y: 10.5 / ROWS });
  assert.ok(near(kept.x, 32.5 / COLUMNS), JSON.stringify(kept));
  const faint = frame([{ column: 8, row: 10, value: 250 }, { column: 32, row: 10, value: 20 }]);
  const switched = centreOfChange(faint, COLUMNS, ROWS, { x: 32.5 / COLUMNS, y: 10.5 / ROWS });
  assert.ok(near(switched.x, 8.5 / COLUMNS), 'a subject that has nearly stopped gives way to the one that moves');
});

test('a still frame has no centre', () => {
  assert.equal(centreOfChange(new Uint8Array(COLUMNS * ROWS), COLUMNS, ROWS), null);
});
