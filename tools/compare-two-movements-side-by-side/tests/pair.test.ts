import test from 'node:test';
import assert from 'node:assert/strict';
import { pairsOf, readPairs } from '../do-work/pair.ts';

const row = (id: string, place: number, extra: Record<string, unknown> = {}) => ({
  id, place, title: `Title ${id}`, detail: '', subject: 'A', reference: 'B', featured: false,
  clip_key: null, student_clip_key: `a-${id}.mp4`, pro_clip_key: `b-${id}.mp4`, student_start: '1.5', pro_start: 0, ...extra,
});
const whole = (id: string, place: number, extra: Record<string, unknown> = {}) => row(id, place, { student_clip_key: null, pro_clip_key: null, clip_key: `${id}-both.mp4`, ...extra });

test('every row is answered in place order, ties broken by id', () => {
  const { pairs } = pairsOf([row('c', 2), row('b', 1), row('a', 1), row('d', 5), row('e', 4)]);
  assert.deepEqual(pairs.map(pair => pair.id), ['a', 'b', 'c', 'e', 'd']);
});

test('start marks are read as seconds, null text becomes empty words, subject and reference label the sides', () => {
  const [pair] = pairsOf([row('a', 0, { detail: null, student_start: '2.25' })]).pairs;
  assert.equal(pair.left!.start_s, 2.25);
  assert.equal(pair.right!.start_s, 0);
  assert.equal(pair.caption, '');
  assert.deepEqual([pair.left!.label, pair.right!.label], ['A', 'B']);
});

test('a bad or negative start mark is zero, never NaN', () => {
  const [pair] = pairsOf([row('a', 0, { student_start: 'soon', pro_start: -3 })]).pairs;
  assert.deepEqual([pair.left!.start_s, pair.right!.start_s], [0, 0]);
});

test('a row with no halves and a clip_key is one video that already holds both movements', () => {
  const [pair] = pairsOf([whole('w', 0, { featured: true, detail: 'Watch the turn.' })]).pairs;
  assert.equal(pair.left, undefined);
  assert.equal(pair.right, undefined);
  assert.deepEqual(pair.video, { label: '', video: 'w-both.mp4', start_s: 0 });
  assert.equal(pair.featured, true);
  assert.equal(pair.caption, 'Watch the turn.');
});

test('a half pair, or a row with nothing to play, is refused by name, not skipped', () => {
  assert.throws(() => pairsOf([row('a', 0), row('x', 1, { pro_clip_key: '' })]), /Comparison x has only one of/);
  assert.throws(() => pairsOf([row('n', 0, { student_clip_key: null, pro_clip_key: null })]), /Comparison n has no clip_key/);
});

test('the read asks for the one table in place order and returns all its rows', async () => {
  const asked: string[] = [];
  const answer = await readPairs({ database: 'any' }, async sql => { asked.push(sql); return [row('a', 0), whole('b', 1), row('c', 2), whole('d', 3), row('e', 4)]; });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /from comparisons order by place, id$/);
  assert.equal(answer.pairs.length, 5);
});
