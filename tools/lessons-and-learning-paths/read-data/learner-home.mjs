// tools/lessons-and-learning-paths/read-data/learner-home.mjs
//
// PURPOSE
//   What the learner's home shows, as one pure function over what the course screens already read: the courses as
//   tool:show-the-courses-a-learner-is-on worked them out, the lesson rows, and the learner's done rows. It picks the one
//   lesson to resume (the next lesson of the course the learner last finished a lesson in), the lessons after it, and
//   each course's progress. A learner who has finished nothing is not started: the home offers the first lesson of the
//   first course, with no progress. Nothing is read or written here.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Done, next and the counts come from showTheCoursesALearnerIsOn's output; nothing here re-derives them.
//   2. A lesson's still and length are the lesson row's own fields the screen names (`video_field`, `length_field`);
//      no field name is assumed here, and a lesson that holds neither shows neither.
//   3. Progress is never made up: a course with nothing done reads 0, and the not-started home shows none.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { lessonInputOf } from './lesson-input.mjs';

const UP_NEXT = 3;

/** A length in seconds as the words a player shows: 4:05, or 1:02:09 past an hour. Nothing for no length. */
export function lengthWords(seconds) {
  const total = Math.round(Number(seconds));
  if (!Number.isFinite(total) || total <= 0) return null;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

const percentOf = (done, of) => (of ? Math.round((done / of) * 100) : 0);

/** The newest done mark of each course, by its done_at (done: the done rows' values, { course_id, lesson_id, done_at }). */
function lastDoneByCourse(done) {
  const last = new Map();
  for (const row of done) {
    const at = Date.parse(row?.done_at ?? '') || 0;
    if (typeof row?.course_id === 'string' && at >= (last.get(row.course_id) ?? -1)) last.set(row.course_id, at);
  }
  return last;
}

/**
 * The home: { started, resume, up_next, courses, closed }.
 *   courses  showTheCoursesALearnerIsOn's output.
 *   lessons  the lesson rows' values by lesson id.
 *   done     the done rows' values ({ course_id, lesson_id, done_at }).
 *   closed   the courses the learner cannot open yet, as the host gives them ({ title }).
 * `resume` is null only when there is no lesson left to take (no course, or every lesson done).
 */
export function learnerHomeOf({ courses, lessons = {}, done = [], videoField = null, lengthField = null, closed = [] }) {
  const lessonOf = (course, index) => {
    const lesson = course.lessons[index];
    const value = lessons[lesson.lesson_id] ?? null;
    const video = lessonInputOf(lesson.lesson_id, value, videoField).video;
    return {
      course_id: course.course_id,
      course_title: course.title,
      lesson_id: lesson.lesson_id,
      title: lesson.title,
      number: index + 1,
      of: course.of,
      still: video?.poster_url ?? null,
      length: lengthWords(lengthField && value ? value[lengthField] : null),
    };
  };
  const started = courses.some(course => course.done > 0);
  const last = lastDoneByCourse(done);
  const open = courses.filter(course => course.lessons.some(lesson => lesson.status === 'active'));
  // The course to resume: the one with the newest finished lesson among those with a lesson left; a learner who has finished
  // nothing starts at the first course.
  const current = started
    ? [...open].filter(course => course.done > 0).sort((a, b) => (last.get(b.course_id) ?? 0) - (last.get(a.course_id) ?? 0))[0] ?? open[0]
    : open[0];
  const activeIndex = current ? current.lessons.findIndex(lesson => lesson.status === 'active') : -1;
  const resume = current ? { ...lessonOf(current, activeIndex), done: current.done, percent: percentOf(current.done, current.of) } : null;
  const upNext = current
    ? current.lessons.slice(activeIndex + 1, activeIndex + 1 + UP_NEXT).map((_, offset) => lessonOf(current, activeIndex + 1 + offset))
    : [];
  return {
    started,
    resume,
    up_next: upNext,
    courses: courses.map(course => {
      const active = course.lessons.findIndex(lesson => lesson.status === 'active');
      return {
        course_id: course.course_id,
        title: course.title,
        done: course.done,
        of: course.of,
        percent: percentOf(course.done, course.of),
        // The lesson a press on the course opens: its next lesson, or its first when every lesson is done.
        opens: course.lessons.length ? lessonOf(course, active >= 0 ? active : 0) : null,
      };
    }),
    closed: (Array.isArray(closed) ? closed : []).filter(course => typeof course?.title === 'string' && course.title).map(course => ({ title: course.title })),
  };
}

/** A words template filled from a values object: "Lesson {number} of {of}" with { number: 2, of: 9 } is "Lesson 2 of 9". */
export function fillWords(template, values) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (whole, name) => (values[name] === undefined || values[name] === null ? whole : String(values[name])));
}
