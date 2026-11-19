// tools/lessons-and-learning-paths/read-data/lesson-input.mjs
//
// PURPOSE
//   What the lesson page (packages/course-lesson/show/CourseLessonSurface.tsx) is given for one `record:lesson` row: its
//   id, each text field the row holds as text (title, summary, body, do_now, primary_resource_id), its resources when
//   the row holds a list, and its video when the caller names the field that holds one. A field the row does not hold is
//   left out, so the page's own empty state shows an unwritten lesson. The video field's name is not known here: the
//   business names it through its list's field roles and the screen passes it in. Pure: the row arrives as a parameter
//   and nothing is read or written here.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const TEXT_FIELDS = ['title', 'summary', 'body', 'do_now', 'primary_resource_id'];

/** A video field holds its address as text, or as an object naming one (`playback_url` or `url`), with its type. */
function videoSourceOf(lessonId, held) {
  const source = typeof held === 'string' ? { playback_url: held } : held;
  if (!source || typeof source !== 'object') return null;
  const playbackUrl = source.playback_url ?? source.url;
  if (typeof playbackUrl !== 'string' || !playbackUrl) return null;
  const details = { label: source.label, mime_type: source.mime_type, poster_url: source.poster_url };
  const kept = Object.entries(details).filter(([, value]) => typeof value === 'string' && value);
  return { id: `${lessonId}:video`, playback_url: playbackUrl, ...Object.fromEntries(kept) };
}

export function lessonInputOf(lessonId, value, videoField = null) {
  const input = { lesson_id: lessonId };
  if (!value) return input;
  for (const field of TEXT_FIELDS) {
    const held = value[field];
    if (typeof held === 'string' && held) input[field] = held;
  }
  if (Array.isArray(value.resources)) input.resources = value.resources;
  const video = videoField ? videoSourceOf(lessonId, value[videoField]) : null;
  if (video) input.video = video;
  return input;
}
