// Tests for the learner's home (read-data/learner-home.mjs). The courses are made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { showTheCoursesALearnerIsOn } from '../read-data/courses-of-a-learner.mjs';
import { fillWords, learnerHomeOf, lengthWords } from '../read-data/learner-home.mjs';

const COURSES = [
  { id: 'bread', title: 'Bread', lessons: ['mix', 'knead', 'proof', 'shape', 'bake'].map(id => ({ id, title: `Bread: ${id}` })) },
  { id: 'cake', title: 'Cake', lessons: ['cream', 'fold', 'ice'].map(id => ({ id, title: `Cake: ${id}` })) },
];
const LESSONS = {
  mix: { title: 'Bread: mix', video: { playback_url: 'https://example.com/mix', poster_url: 'https://example.com/mix.jpg' }, length_s: 245 },
  knead: { title: 'Bread: knead', video: 'https://example.com/knead', length_s: 3729 },
  proof: { title: 'Bread: proof' },
};
const homeOf = (done, extra = {}) => learnerHomeOf({
  courses: showTheCoursesALearnerIsOn({ courses: COURSES, done }),
  lessons: LESSONS,
  done,
  videoField: 'video',
  lengthField: 'length_s',
  ...extra,
});

test('a learner who has finished nothing starts at the first lesson of the first course, with no progress', () => {
  const home = homeOf([]);
  assert.equal(home.started, false);
  assert.deepEqual(home.resume, { course_id: 'bread', course_title: 'Bread', lesson_id: 'mix', title: 'Bread: mix', number: 1, of: 5, still: 'https://example.com/mix.jpg', length: '4:05', done: 0, percent: 0 });
  assert.deepEqual(home.up_next.map(lesson => lesson.lesson_id), ['knead', 'proof', 'shape']);
  assert.deepEqual(home.courses.map(course => [course.course_id, course.done, course.of, course.percent]), [['bread', 0, 5, 0], ['cake', 0, 3, 0]]);
});

test('the home resumes the course the learner last finished a lesson in, at its next lesson', () => {
  const done = [
    { course_id: 'bread', lesson_id: 'mix', done_at: '2026-11-01T10:00:00.000Z' },
    { course_id: 'cake', lesson_id: 'cream', done_at: '2026-11-20T10:00:00.000Z' },
  ];
  const home = homeOf(done);
  assert.equal(home.started, true);
  assert.equal(home.resume.course_id, 'cake');
  assert.equal(home.resume.lesson_id, 'fold');
  assert.equal(home.resume.number, 2);
  assert.equal(home.resume.percent, 33);
  assert.deepEqual(home.up_next.map(lesson => lesson.lesson_id), ['ice']);
});

test('a finished course is not resumed: the next course with a lesson left is', () => {
  const done = ['cream', 'fold', 'ice'].map((lesson_id, n) => ({ course_id: 'cake', lesson_id, done_at: `2026-11-2${n}T10:00:00.000Z` }))
    .concat({ course_id: 'bread', lesson_id: 'mix', done_at: '2026-11-01T10:00:00.000Z' });
  const home = homeOf(done);
  assert.equal(home.resume.course_id, 'bread');
  assert.equal(home.resume.lesson_id, 'knead');
  assert.equal(home.resume.still, null, 'a video given as text has no poster');
  assert.equal(home.resume.length, '1:02:09');
  const cake = home.courses.find(course => course.course_id === 'cake');
  assert.deepEqual([cake.done, cake.percent, cake.opens.lesson_id], [3, 100, 'cream']);
});

test('with every lesson done there is nothing to resume', () => {
  const done = COURSES.flatMap(course => course.lessons.map(lesson => ({ course_id: course.id, lesson_id: lesson.id, done_at: '2026-11-02T00:00:00.000Z' })));
  const home = homeOf(done);
  assert.equal(home.resume, null);
  assert.deepEqual(home.up_next, []);
});

test('a lesson without a still or a length shows neither, and no field name is assumed', () => {
  const home = learnerHomeOf({ courses: showTheCoursesALearnerIsOn({ courses: COURSES, done: [] }), lessons: LESSONS });
  assert.equal(home.resume.still, null);
  assert.equal(home.resume.length, null);
});

test('the closed courses the host gives are kept by title only', () => {
  const home = homeOf([], { closed: [{ title: 'Pastry', access: 'x' }, { title: '' }, null] });
  assert.deepEqual(home.closed, [{ title: 'Pastry' }]);
  assert.deepEqual(homeOf([], { closed: 'none' }).closed, []);
});

test('no course gives no resume and no rows', () => {
  assert.deepEqual(learnerHomeOf({ courses: [] }), { started: false, resume: null, up_next: [], courses: [], closed: [] });
});

test('lengths read as a player shows them', () => {
  assert.equal(lengthWords(59), '0:59');
  assert.equal(lengthWords(600), '10:00');
  assert.equal(lengthWords(0), null);
  assert.equal(lengthWords('x'), null);
});

test('words fill their braces and keep a brace they have no value for', () => {
  assert.equal(fillWords('Lesson {number} of {of}', { number: 2, of: 9 }), 'Lesson 2 of 9');
  assert.equal(fillWords('lesson:{course_id}:{lesson_id}', { course_id: 'bread', lesson_id: 'mix' }), 'lesson:bread:mix');
  assert.equal(fillWords('Hi {name}', {}), 'Hi {name}');
});
