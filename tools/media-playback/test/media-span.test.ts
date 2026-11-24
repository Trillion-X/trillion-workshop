import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaSpanOf } from '../read-data/media-span.ts';

test('a media fragment names the part of the file to play', () => {
  assert.deepEqual(mediaSpanOf('https://www.youtube.com/watch?v=abc#t=1307,1353'), { start: 1307, end: 1353 });
  assert.deepEqual(mediaSpanOf('https://files.example/lesson.mp4#t=npt:10.5,20'), { start: 10.5, end: 20 });
  assert.deepEqual(mediaSpanOf('https://files.example/lesson.mp4#t=21:47,22:23'), { start: 1307, end: 1343 });
  assert.deepEqual(mediaSpanOf('https://files.example/lesson.mp4#t=1:00:00'), { start: 3600 });
  assert.deepEqual(mediaSpanOf('https://files.example/lesson.mp4#t=,30'), { start: 0, end: 30 });
});

test("YouTube's own start, end and t words are read when there is no fragment", () => {
  assert.deepEqual(mediaSpanOf('https://www.youtube.com/embed/abc?start=90&end=120'), { start: 90, end: 120 });
  assert.deepEqual(mediaSpanOf('https://youtu.be/abc?t=1m30s'), { start: 90 });
  assert.deepEqual(mediaSpanOf('https://www.youtube.com/watch?v=abc&t=45'), { start: 45 });
});

test('an address with no part, or a part that cannot be, plays the whole file', () => {
  assert.equal(mediaSpanOf('https://www.youtube.com/watch?v=abc'), null);
  assert.equal(mediaSpanOf('https://files.example/lesson.mp4#t=30,10'), null);
  assert.equal(mediaSpanOf('https://files.example/lesson.mp4#t=soon'), null);
  assert.equal(mediaSpanOf('https://files.example/lesson.mp4#t=0'), null);
  assert.equal(mediaSpanOf(''), null);
  assert.equal(mediaSpanOf(undefined), null);
});
