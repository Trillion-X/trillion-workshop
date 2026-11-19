// tools/lessons-and-learning-paths/read-data/courses-of-a-learner.mjs
//
// PURPOSE
//   The learning page's read as one pure function: each course the person is on, as a path of its lessons in order, with
//   how many are done, the lesson the person is on now, and each lesson's words. The course list screen (web/) and
//   tool:show-the-courses-a-learner-is-on (do-work/) both run this one function; nothing is read or written here.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
//

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
