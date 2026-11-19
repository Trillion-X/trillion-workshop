// tools/lessons-and-learning-paths/read-data/lesson-done.mjs
//
// PURPOSE
//   The one place that names a lesson's done row: its record type, its id for one learner's finish of one lesson in one
//   course, and its value. The lesson screen writes it when the person marks a lesson done; the course list reads those
//   rows back and hands them to tool:show-the-courses-a-learner-is-on as { course_id, lesson_id }. Pure: nothing is read
//   or written here.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export const LESSON_DONE_TYPE = 'record:lesson-done';

export function lessonDoneRecordId(courseId, lessonId) {
  return `${LESSON_DONE_TYPE}:${encodeURIComponent(courseId)}:${encodeURIComponent(lessonId)}`;
}

export function lessonDoneValue(courseId, lessonId, doneAt) {
  return { course_id: courseId, lesson_id: lessonId, done_at: doneAt };
}

/** The finished lessons the done rows name, as tool:show-the-courses-a-learner-is-on takes them. */
export function finishedLessonsOf(doneRecords) {
  return doneRecords
    .map(record => record.value)
    .filter(value => value && typeof value.course_id === 'string' && typeof value.lesson_id === 'string')
    .map(({ course_id, lesson_id }) => ({ course_id, lesson_id }));
}
