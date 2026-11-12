// tools/lessons-and-learning-paths/do-work/show-the-courses-a-learner-is-on.mjs
//
// tool:show-the-courses-a-learner-is-on, run as a function in the tool container:
//
//   node do-work/show-the-courses-a-learner-is-on.mjs < <the input as JSON>
//
// and prints { result } on its last line (or { error } with exit 1). It is the learning page's own read: each course
// the person is on, as a path of its lessons in order, with how many are done, the lesson the person is on now, and
// each lesson's words. The caller reads the courses and the lessons this learner has finished and hands them over.
//
// Port of old trillion src/community-activity.mjs `coursesFor(community, relay)` (commit HEAD at the time of this port),
// with its path from src/community-logic/project-progress-to-path.ts: a done lesson is complete, the first lesson not done
// is active, the rest are locked. A lesson's interactive module is not carried: it was shared only inside one relay.
import { readFileSync } from 'node:fs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function showTheCoursesALearnerIsOn({ courses, done = [] }) {
  if (!Array.isArray(courses) || !courses.every(course => object(course) && typeof course.id === 'string' && typeof course.title === 'string'
    && Array.isArray(course.lessons) && course.lessons.every(lesson => object(lesson) && typeof lesson.id === 'string' && typeof lesson.title === 'string'))) {
    throw new Error('courses is a list of { id, title, about?, lessons: [{ id, title, body? }] }.');
  }
  if (!Array.isArray(done) || !done.every(row => object(row) && typeof row.course_id === 'string' && typeof row.lesson_id === 'string')) {
    throw new Error('done is a list of { course_id, lesson_id } the learner has finished.');
  }
  const finished = new Set(done.map(row => `${row.course_id}/${row.lesson_id}`));
  return courses.map(course => {
    const firstOpen = course.lessons.findIndex(lesson => !finished.has(`${course.id}/${lesson.id}`));
    const lessons = course.lessons.map((lesson, index) => {
      const complete = finished.has(`${course.id}/${lesson.id}`);
      const status = complete ? 'complete' : index === firstOpen ? 'active' : 'locked';
      return { lesson_id: lesson.id, title: lesson.title, status, body: lesson.body ?? null, ...(lesson.module ? { interactive: true } : {}) };
    });
    return { course_id: course.id, title: course.title, about: course.about ?? null,
      done: lessons.filter(lesson => lesson.status === 'complete').length, of: lessons.length, lessons };
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  try {
    process.stdout.write(JSON.stringify({ result: { courses: showTheCoursesALearnerIsOn(JSON.parse(readFileSync(0, 'utf8') || '{}')) } }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message }) + '\n');
    process.exitCode = 1;
  }
}
