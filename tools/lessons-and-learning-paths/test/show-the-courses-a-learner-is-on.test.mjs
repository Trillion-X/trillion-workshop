// Tests for tool:show-the-courses-a-learner-is-on. The bakery course is made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { showTheCoursesALearnerIsOn } from '../do-work/show-the-courses-a-learner-is-on.mjs';

const courses = [{ id: 'course:bread', title: 'Baking bread', about: 'From dough to loaf.', lessons: [
  { id: 'knead', title: 'Knead', body: 'Work the dough.' },
  { id: 'proof', title: 'Proof', body: 'Let it rise.', module: { file: 'x.js' } },
  { id: 'bake', title: 'Bake' },
] }];

test('done lessons are complete, the first open one is active, the rest locked', () => {
  const [course] = showTheCoursesALearnerIsOn({ courses, done: [{ course_id: 'course:bread', lesson_id: 'knead' }] });
  assert.equal(course.done, 1);
  assert.equal(course.of, 3);
  assert.deepEqual(course.lessons.map(lesson => lesson.status), ['complete', 'active', 'locked']);
  assert.equal(course.lessons[0].body, 'Work the dough.');
  assert.equal(course.lessons[1].interactive, true);
  assert.equal(course.lessons[2].body, null);
});

test('a finished course has no active lesson, and a course with nothing done starts at its first lesson', () => {
  const finished = showTheCoursesALearnerIsOn({ courses, done: ['knead', 'proof', 'bake'].map(lesson_id => ({ course_id: 'course:bread', lesson_id })) });
  assert.deepEqual(finished[0].lessons.map(lesson => lesson.status), ['complete', 'complete', 'complete']);
  const fresh = showTheCoursesALearnerIsOn({ courses });
  assert.deepEqual(fresh[0].lessons.map(lesson => lesson.status), ['active', 'locked', 'locked']);
});

test('a bad request is refused', () => {
  assert.throws(() => showTheCoursesALearnerIsOn({ courses: [{ id: 'x' }] }), /courses/);
  assert.throws(() => showTheCoursesALearnerIsOn({ courses, done: ['knead'] }), /done/);
});
