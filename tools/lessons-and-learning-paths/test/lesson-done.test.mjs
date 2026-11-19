// Tests for the done row (read-data/lesson-done.mjs) and the video field of the lesson input. The lessons are made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LESSON_DONE_TYPE, finishedLessonsOf, lessonDoneRecordId, lessonDoneValue } from '../read-data/lesson-done.mjs';
import { lessonInputOf } from '../read-data/lesson-input.mjs';

test('a done row has one id per learner-course-lesson and names both ids in its value', () => {
  assert.equal(lessonDoneRecordId('course:bread', 'record:lesson:knead'), 'record:lesson-done:course%3Abread:record%3Alesson%3Aknead');
  assert.notEqual(lessonDoneRecordId('course:a', 'b:c'), lessonDoneRecordId('course:a:b', 'c'));
  assert.deepEqual(lessonDoneValue('course:bread', 'knead', '2026-01-01T12:00:00.000Z'), { course_id: 'course:bread', lesson_id: 'knead', done_at: '2026-01-01T12:00:00.000Z' });
});

test('finished lessons are read from the done rows, and a row with no value is not finished', () => {
  const rows = [
    { id: 'a', type: LESSON_DONE_TYPE, value: lessonDoneValue('course:bread', 'knead', 'now') },
    { id: 'b', type: LESSON_DONE_TYPE, value: { course_id: 'course:bread' } },
    { id: 'c', type: LESSON_DONE_TYPE, value: null },
  ];
  assert.deepEqual(finishedLessonsOf(rows.filter(row => row.value)), [{ course_id: 'course:bread', lesson_id: 'knead' }]);
});

test('the video is the field the caller names, read as a playable source', () => {
  const row = { title: 'Knead', video: { playback_url: 'https://example.com/knead.mp4', mime_type: 'video/mp4' } };
  assert.deepEqual(lessonInputOf('record:lesson:knead', row, 'video').video, {
    id: 'record:lesson:knead:video', playback_url: 'https://example.com/knead.mp4', mime_type: 'video/mp4',
  });
  assert.deepEqual(lessonInputOf('record:lesson:knead', { clip: 'https://example.com/clip.mp4' }, 'clip').video.playback_url, 'https://example.com/clip.mp4');
});

test('no video field named, or a field that holds no address, gives the lesson no video', () => {
  const row = { title: 'Knead', video: { playback_url: 'https://example.com/knead.mp4' } };
  assert.equal('video' in lessonInputOf('record:lesson:knead', row), false);
  assert.equal('video' in lessonInputOf('record:lesson:knead', { video: { mime_type: 'video/mp4' } }, 'video'), false);
  assert.equal('video' in lessonInputOf('record:lesson:knead', { video: 42 }, 'video'), false);
});
