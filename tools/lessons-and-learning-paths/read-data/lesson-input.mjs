// tools/lessons-and-learning-paths/read-data/lesson-input.mjs
//
// PURPOSE
//   What the lesson page (packages/course-lesson/show/CourseLessonSurface.tsx) is given for one `record:lesson` row: its
//   id, each text field the row holds as text (title, summary, body, do_now, primary_resource_id) and its resources when
//   the row holds a list. A field the row does not hold is left out, so the page's own empty state shows an unwritten
//   lesson. Pure: the row arrives as a parameter and nothing is read or written here.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const TEXT_FIELDS = ['title', 'summary', 'body', 'do_now', 'primary_resource_id'];

export function lessonInputOf(lessonId, value) {
  const input = { lesson_id: lessonId };
  if (!value) return input;
  for (const field of TEXT_FIELDS) {
    const held = value[field];
    if (typeof held === 'string' && held) input[field] = held;
  }
  if (Array.isArray(value.resources)) input.resources = value.resources;
  return input;
}
