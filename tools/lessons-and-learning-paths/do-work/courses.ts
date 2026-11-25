// tools/lessons-and-learning-paths/do-work/courses.ts
//
// PURPOSE
//   The reads behind the course screen (show/Course.tsx) and the lesson screen (show/Lesson.tsx). Each reader answers the
//   exact props of its screen, so a page and an AI's call get the same answer and the same screen. A reader holds no login
//   and no client: it is handed `rows(sql, params)` by run-sql-in-my-database/do-work/serve-a-read.ts, which runs every
//   statement of one read in one read-only transaction on the connection the engine mounts for the named database.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The only names of tables and columns are in SOURCE below, and every table name a caller gives (input.tables) is a
//      plain identifier that is quoted before it reaches a statement; no caller text is ever part of a statement.
//   2. A lesson with no timed words answers no segments, never invented ones; a video the lesson has no address for is
//      answered as null, so the screen draws the lesson's words without a player.
//   3. The learner's done marks are read only when a person is named and the done table exists; a missing table is an
//      empty set, not a failure, so a course page opens before any lesson has been marked done.
//   4. Passages are cut from the words by pauses and sentence ends only (passagesFromWords); the words, their times and
//      their order are the stored ones.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Reader, Rows } from '../../run-sql-in-my-database/do-work/serve-a-read.ts';

// The one block that names tables and columns. A table name here is the default; input.tables replaces any of them.
export const SOURCE = {
  tables: {
    courses: 'courses',
    lessons: 'lessons',
    words: 'lesson_video_words',
    links: 'lesson_video_links',
    done: 'lesson_done',
  },
  courses: { slug: 'slug', title: 'title', description: 'description', short_description: 'short_description', order: 'sort_order' },
  lessons: { course: 'course_id', id: 'lesson_id', position: 'position', title: 'title', video: 'video_id' },
  words: { video: 'video_id', n: 'n', word: 'word', start: 'start_s', end: 'end_s' },
  links: { lesson: 'lesson_id', url: 'video_url' },
  done: { person: 'person', course: 'course_id', lesson: 'lesson_id', at: 'done_at' },
} as const;

// A pause this long ends a passage; so does a sentence end once the passage holds enough words; no passage holds more.
export const PASSAGE = { pauseSeconds: 1.2, sentenceMinimumWords: 8, mostWords: 40 } as const;

export type Tables = Record<keyof typeof SOURCE.tables, string>;
export type Timed = { word: string; start: number; end: number };
export type Passage = { id: string; start: number; end: number; speaker?: string; text: string; words: Timed[] };
export type LessonLink = { id: string; position: number; title: string; href: string; done: boolean };
export type CourseAnswer = {
  course: { slug: string; title: string; description: string };
  lessons: LessonLink[];
  doneCount: number;
};
export type VideoAnswer = { kind: 'youtube'; embedUrl: string } | { kind: 'file'; url: string } | null;
export type LessonAnswer = {
  course: { slug: string; title: string };
  lesson: { id: string; position: number; title: string; done: boolean };
  video: VideoAnswer;
  segments: Passage[];
  previous: { title: string; href: string } | null;
  next: { title: string; href: string } | null;
};
type Given = { database: string; course: string; person?: string; tables?: Partial<Tables>; lesson_path?: string };

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const quote = (name: string) => `"${name}"`;

export function tablesOf(given: Partial<Tables> | undefined): Tables {
  const tables: Tables = { ...SOURCE.tables };
  for (const [key, name] of Object.entries(given ?? {})) {
    if (!(key in tables)) throw new Error(`tables.${key} is not a table this tool reads.`);
    if (typeof name !== 'string' || !IDENTIFIER.test(name)) throw new Error(`tables.${key} must be a plain table name (lower case letters, digits and _).`);
    tables[key as keyof Tables] = name;
  }
  return tables;
}

// A path template such as /courses/{course}/lessons/{lesson}; with none, the address is the bare id.
export function lessonHref(template: string | undefined, course: string, lesson: string): string {
  if (template === undefined) return lesson;
  return template.replace('{course}', encodeURIComponent(course)).replace('{lesson}', encodeURIComponent(lesson));
}

export function embedUrlOf(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const host = parsed.hostname.replace(/^www\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = parsed.pathname.slice(1);
  else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    id = parsed.pathname === '/watch' ? parsed.searchParams.get('v') : /^\/(embed|shorts)\/([^/]+)/.exec(parsed.pathname)?.[2] ?? null;
  }
  return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
}

export function videoOf(url: string | null | undefined, filesBase: string | undefined): VideoAnswer {
  if (!url) return null;
  const embedUrl = embedUrlOf(url);
  if (embedUrl) return { kind: 'youtube', embedUrl };
  if (/^https?:\/\//.test(url)) return { kind: 'file', url };
  return filesBase ? { kind: 'file', url: `${filesBase.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}` } : null;
}

export function passagesFromWords(words: readonly Timed[]): Passage[] {
  const passages: Passage[] = [];
  let open: Timed[] = [];
  const close = () => {
    if (!open.length) return;
    passages.push({ id: `p${passages.length}`, start: open[0].start, end: open[open.length - 1].end, text: open.map(item => item.word).join(' '), words: open });
    open = [];
  };
  words.forEach((item, index) => {
    open.push(item);
    const next = words[index + 1];
    const paused = next !== undefined && next.start - item.end >= PASSAGE.pauseSeconds;
    const sentence = /[.!?]["')\]]?$/.test(item.word) && open.length >= PASSAGE.sentenceMinimumWords;
    if (paused || sentence || open.length >= PASSAGE.mostWords) close();
  });
  close();
  return passages;
}

const number = (value: unknown) => Number(value);

async function doneIds(rows: Rows, tables: Tables, person: string | undefined, course: string): Promise<Set<string>> {
  if (!person) return new Set();
  const present = await rows('select to_regclass($1) is not null as present', [quote(tables.done)]);
  if (present[0]?.present !== true) return new Set();
  const { done } = SOURCE;
  const found = await rows(`select ${quote(done.lesson)} as lesson from ${quote(tables.done)} where ${quote(done.person)} = $1 and ${quote(done.course)} = $2`, [person, course]);
  return new Set(found.map(row => String(row.lesson)));
}

async function lessonRows(rows: Rows, tables: Tables, course: string) {
  const { lessons } = SOURCE;
  return rows(`select ${quote(lessons.id)} as id, ${quote(lessons.position)} as position, ${quote(lessons.title)} as title, ${quote(lessons.video)} as video from ${quote(tables.lessons)} where ${quote(lessons.course)} = $1 order by ${quote(lessons.position)}`, [course]);
}

async function courseRow(rows: Rows, tables: Tables, course: string) {
  const { courses } = SOURCE;
  const found = await rows(`select ${quote(courses.slug)} as slug, ${quote(courses.title)} as title, coalesce(${quote(courses.description)}, ${quote(courses.short_description)}, '') as description from ${quote(tables.courses)} where ${quote(courses.slug)} = $1`, [course]);
  if (!found[0]) throw new Error(`There is no course ${course}.`);
  return { slug: String(found[0].slug), title: String(found[0].title), description: String(found[0].description) };
}

export const readCourse: Reader<Given, CourseAnswer> = async (input, rows) => {
  const tables = tablesOf(input.tables);
  const course = await courseRow(rows, tables, input.course);
  const done = await doneIds(rows, tables, input.person, input.course);
  const lessons = (await lessonRows(rows, tables, input.course)).map(row => ({
    id: String(row.id), position: number(row.position), title: String(row.title),
    href: lessonHref(input.lesson_path, input.course, String(row.id)), done: done.has(String(row.id)),
  }));
  return { course, lessons, doneCount: lessons.filter(lesson => lesson.done).length };
};

export const readLesson: Reader<Given & { lesson: string; files_base_url?: string }, LessonAnswer> = async (input, rows) => {
  const tables = tablesOf(input.tables);
  const course = await courseRow(rows, tables, input.course);
  const all = await lessonRows(rows, tables, input.course);
  const at = all.findIndex(row => String(row.id) === input.lesson);
  if (at < 0) throw new Error(`There is no lesson ${input.lesson} in course ${input.course}.`);
  const current = all[at];
  const done = await doneIds(rows, tables, input.person, input.course);
  const { links, words } = SOURCE;
  const linked = await rows(`select ${quote(links.url)} as url from ${quote(tables.links)} where ${quote(links.lesson)} = $1 limit 1`, [input.lesson]);
  const spoken = current.video === null ? [] : await rows(`select ${quote(words.word)} as word, ${quote(words.start)} as start, ${quote(words.end)} as "end" from ${quote(tables.words)} where ${quote(words.video)} = $1 order by ${quote(words.n)}`, [String(current.video)]);
  const around = (row: Record<string, unknown> | undefined) => row ? { title: String(row.title), href: lessonHref(input.lesson_path, input.course, String(row.id)) } : null;
  return {
    course: { slug: course.slug, title: course.title },
    lesson: { id: String(current.id), position: number(current.position), title: String(current.title), done: done.has(String(current.id)) },
    video: videoOf(linked[0] ? String(linked[0].url) : null, input.files_base_url),
    segments: passagesFromWords(spoken.map(row => ({ word: String(row.word), start: number(row.start), end: number(row.end) }))),
    previous: around(all[at - 1]),
    next: around(all[at + 1]),
  };
};

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const { serveARead } = await import('../../run-sql-in-my-database/do-work/serve-a-read.ts');
  await serveARead({ readCourse, readLesson });
}
