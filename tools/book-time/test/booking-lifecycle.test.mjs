// The booking lifecycle is plain data. These checks keep it a sound { stages, transitions, start } file.
import test from 'node:test';
import assert from 'node:assert/strict';
import lifecycle from '../read-data/booking-lifecycle.json' with { type: 'json' };

const keys = new Set(lifecycle.stages.map(stage => stage.key));

test('every stage is declared once and every move names declared stages', () => {
  assert.equal(keys.size, lifecycle.stages.length);
  assert.ok(keys.has(lifecycle.start));
  for (const move of lifecycle.transitions) assert.ok(keys.has(move.from) && keys.has(move.to), `${move.from} -> ${move.to}`);
});

test('nothing moves out of a finished stage, and every stage can be reached from the start', () => {
  const finished = new Set(lifecycle.stages.filter(stage => stage.terminal).map(stage => stage.key));
  assert.ok(finished.size > 0);
  for (const move of lifecycle.transitions) assert.ok(!finished.has(move.from), `${move.from} is finished`);
  const reached = new Set([lifecycle.start]);
  for (let grew = true; grew;) {
    grew = false;
    for (const move of lifecycle.transitions) if (reached.has(move.from) && !reached.has(move.to)) { reached.add(move.to); grew = true; }
  }
  assert.deepEqual([...reached].sort(), [...keys].sort());
});

test('no move waits on a condition, which this tool\'s own check does not read', () => {
  for (const move of lifecycle.transitions) assert.equal(move.when, undefined);
});
