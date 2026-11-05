// test/track-alignment-measure.test.mjs
//
// Separate tracks of one recording are checked to be in step (trillion-workshop tools/media-composition/read-data/track-alignment.mjs): the lag of each
// file against its wall clock is compared to the earliest track's, the furthest out is named, the shift to fix it is given, and a
// track that cannot be read is reported while the others are still compared.
import assert from 'node:assert/strict';
import test from 'node:test';
import rules from '../read-data/track-alignment.json' with { type: 'json' };
import { alignmentProbe, measureAlignment, seekPoints } from '../read-data/track-alignment.mjs';

const track = (id, wall, first) => ({ id, wall_clock_ms: wall, first_timestamp_ms: first });

test('tracks whose files start where their wall clocks say are in step, whatever their absolute times', () => {
  const result = measureAlignment([track('screen', 1000, 0), track('camera', 1120, 120), track('mic', 1300, 300)]);
  assert.equal(result.in_step, true);
  assert.equal(result.skew_ms, 0);
  assert.equal(result.reference, 'screen');
  assert.equal(result.said, 'All 3 tracks are in step (the furthest apart is 0 ms).');
});

test('a track that starts late against its wall clock is named, with the shift that fixes it', () => {
  const result = measureAlignment([track('screen', 1000, 0), track('camera', 1100, 100), track('mic', 1050, 130)]);
  assert.equal(result.in_step, false);
  assert.equal(result.worst, 'mic');
  assert.deepEqual(result.offsets.find((o) => o.id === 'mic'), { id: 'mic', offset_ms: 80, shift_ms: -80 });
  assert.equal(result.skew_ms, 80);
  assert.equal(result.said, 'mic is 80 ms behind the others; the furthest apart are 80 ms and 40 ms is allowed.');
  const early = measureAlignment([track('a', 0, 0), track('b', 0, -70)]);
  assert.equal(early.said, 'b is 70 ms ahead of the others; the furthest apart are 70 ms and 40 ms is allowed.');
});

test('the tolerance is the limit, inclusive, and comes from DATA', () => {
  assert.equal(measureAlignment([track('a', 0, 0), track('b', 0, rules.tolerance_ms)]).in_step, true);
  assert.equal(measureAlignment([track('a', 0, 0), track('b', 0, rules.tolerance_ms + 1)]).in_step, false);
  assert.equal(measureAlignment([track('a', 0, 0), track('b', 0, 100)], { ...rules, tolerance_ms: 100 }).in_step, true);
});

test('adding a track never changes how the others compare, and one track has nothing to line up', () => {
  const two = measureAlignment([track('screen', 1000, 0), track('mic', 1000, 50)]);
  const three = measureAlignment([track('screen', 1000, 0), track('mic', 1000, 50), track('camera', 1200, 200)]);
  assert.deepEqual(three.offsets.find((o) => o.id === 'mic'), two.offsets.find((o) => o.id === 'mic'));
  const one = measureAlignment([track('screen', 1000, 0)]);
  assert.deepEqual([one.in_step, one.said], [true, rules.words.one_track]);
  assert.deepEqual(measureAlignment([]).offsets, []);
});

test('the probe reads each track\'s start, reports one it cannot read, and still compares the rest', async () => {
  const starts = { screen: 0, camera: 130 };
  const result = await alignmentProbe({
    tracks: [{ id: 'screen', wall_clock_ms: 1000 }, { id: 'camera', wall_clock_ms: 1000 }, { id: 'mic', wall_clock_ms: 1000 }, { id: 'sys', wall_clock_ms: 1000 }],
    readStart: async (found) => { if (found.id === 'mic') throw new Error('bad playlist'); if (found.id === 'sys') return Number.NaN; return starts[found.id]; },
  });
  assert.deepEqual(result.unreadable.map((u) => u.id), ['mic', 'sys']);
  assert.equal(result.unreadable[0].said, 'mic could not be read, so its place against the others is not known.');
  assert.equal(result.in_step, false);
  assert.equal(result.worst, 'camera');
});

test('the probe seeks at the DATA\'s points of the recording', () => {
  assert.deepEqual(seekPoints(10000), [1000, 4500, 8000, 5000, 9500]);
});
