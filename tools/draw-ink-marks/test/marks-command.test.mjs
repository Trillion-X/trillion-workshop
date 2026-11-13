// tools/draw-ink-marks: the three commands, run the way the tool container runs them, over made-up marks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const script = new URL('../do-work/marks.mjs', import.meta.url).pathname;
const run = async (verb, input) => {
  const pending = exec('node', [script, verb]);
  pending.child.stdin.end(JSON.stringify(input));
  const done = await pending.catch(error => error);
  return { status: done.code ?? 0, answer: JSON.parse(done.stdout.trim().split('\n').at(-1)) };
};

const wall = { address: 'wall' };
const operations = [
  { id: 'line', sequence: 1, target: wall, style_ref: 'pen', body: { coordinate_sets: [{ points: [{ values: [0, 0] }, { values: [10, 0] }] }] } },
  { id: 'box', sequence: 2, target: wall, body: { coordinate_sets: [{ closed: true, points: [{ values: [20, 0] }, { values: [30, 0] }, { values: [30, 10] }] }], style: { stroke: '#222' } } },
  { id: 'elsewhere', sequence: 3, target: { address: 'floor' }, body: { coordinate_sets: [{ points: [{ values: [1, 1] }, { values: [2, 2] }] }] } },
];
const styles = [{ id: 'pen', stroke: '#111', stroke_width: 2 }];

test('see lists the visible marks of one space with their style', async () => {
  const { status, answer } = await run('see', { operations, styles, target: wall });
  assert.equal(status, 0);
  assert.deepEqual(answer.result.marks.map(mark => mark.ref), ['line:set:0', 'box:set:0']);
  assert.equal(answer.result.marks[0].style.stroke_width, 2);
  assert.deepEqual(answer.result.hidden_refs, []);
});

test('stroke turns drawn points into the figure the tool row chooses', async () => {
  const { answer } = await run('stroke', { tool: { id: 't', mapper: { kind: 'polygon', corners: true, closed: true } }, points: [[0, 0], [5, 5], [10, 4]] });
  assert.deepEqual(answer.result, { points: [[0, 0], [10, 0], [10, 4], [0, 4]], closed: true, erases: false });
  const erase = await run('stroke', { tool: { id: 'e', mode: 'erase' }, points: [{ values: [1, 1] }] });
  assert.equal(erase.answer.result.erases, true);
});

test('erase answers the mark to hide, as the effect to append, or nothing', async () => {
  const near = await run('erase', { operations, styles, target: wall, point: [5, 1], radius: 2 });
  assert.deepEqual(near.answer.result, { ref: 'line:set:0', effects: { hide_refs: ['line:set:0'] } });
  const far = await run('erase', { operations, styles, target: wall, point: [5, 50], radius: 2 });
  assert.deepEqual(far.answer.result, { ref: null, effects: null });
});

test('requests that cannot be read are refused with what to fix', async () => {
  assert.match((await run('erase', { operations, target: wall, point: [1], radius: 2 })).answer.error, /point must be/);
  assert.match((await run('erase', { operations, target: wall, point: [1, 1], radius: -1 })).answer.error, /radius/);
  assert.match((await run('draw', {})).answer.error, /use see, stroke or erase/);
  assert.match((await run('see', { operations: 'no' })).answer.error, /operations must be/);
});
