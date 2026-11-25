import test from 'node:test';
import assert from 'node:assert/strict';
import { readCourses, embedUrlOf, lessonHref, passagesFromWords, readCourse, readLesson, tablesOf, videoOf } from '../do-work/courses.ts';
import { readDone, saveDone } from '../do-work/progress.ts';

type Call = { sql: string; params: unknown[] };
function fake(answer: (sql: string, params: unknown[]) => Record<string, unknown>[]) {
  const calls: Call[] = [];
  const rows = async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return answer(sql, params); };
  return { calls, rows };
}
const courseRows = (sql: string) => {
  if (sql.includes('from "courses"')) return [{ slug: 'c', title: 'The Course', description: 'About', image: 'abcdefghijk', category: 'Masterclass', short_description: 'Short.', features: ['A', 'B'], objectives: ['C'], requirements: null, preview: 'Gaz2qA4t3Fs' }];
  if (sql.includes('from "lessons"')) return [{ id: 'l1', position: 1, title: 'One', video: 'v1' }, { id: 'l2', position: 2, title: 'Two', video: null }];
  return [];
};

test('a YouTube address of any common form becomes the privacy-enhanced embed address; anything else is none', () => {
  for (const url of ['https://youtu.be/abcdefghijk', 'https://www.youtube.com/watch?v=abcdefghijk', 'https://youtube.com/embed/abcdefghijk', 'https://m.youtube.com/shorts/abcdefghijk']) {
    assert.equal(embedUrlOf(url), 'https://www.youtube-nocookie.com/embed/abcdefghijk');
  }
  assert.equal(embedUrlOf('https://example.com/watch?v=abcdefghijk'), null);
  assert.equal(embedUrlOf('not an address'), null);
  assert.equal(embedUrlOf('https://youtube.com/watch?v=a b'), null);
});

test('a recording is a frame, a full address, a storage key with a base, or nothing', () => {
  assert.deepEqual(videoOf('https://youtu.be/abcdefghijk', undefined), { kind: 'youtube', embedUrl: 'https://www.youtube-nocookie.com/embed/abcdefghijk' });
  assert.deepEqual(videoOf('https://files.example/a.mp4', undefined), { kind: 'file', url: 'https://files.example/a.mp4' });
  assert.deepEqual(videoOf('lessons/a.mp4', '/files/'), { kind: 'file', url: '/files/lessons/a.mp4' });
  assert.equal(videoOf('lessons/a.mp4', undefined), null);
  assert.equal(videoOf(null, '/files/'), null);
});

test('table names a caller gives must be plain identifiers and known keys', () => {
  assert.equal(tablesOf({ lessons: 'my_lessons' }).lessons, 'my_lessons');
  assert.throws(() => tablesOf({ lessons: 'x"; drop table y; --' }), /plain table name/);
  assert.throws(() => tablesOf({ nope: 'x' } as never), /not a table/);
});

test('lesson addresses fill the path template, or are the bare id', () => {
  assert.equal(lessonHref('/courses/{course}/lessons/{lesson}', 'a b', 'l1'), '/courses/a%20b/lessons/l1');
  assert.equal(lessonHref(undefined, 'c', 'l1'), 'l1');
});

test('passages are cut by pauses and sentence ends, and keep every word in order', () => {
  const words = ['One', 'two', 'three.', 'Four'].map((word, index) => ({ word, start: index + (index === 3 ? 5 : 0), end: index + 0.9 + (index === 3 ? 5 : 0) }));
  const passages = passagesFromWords(words);
  assert.equal(passages.length, 2);
  assert.deepEqual(passages.flatMap(passage => passage.words.map(item => item.word)), ['One', 'two', 'three.', 'Four']);
  assert.deepEqual(passagesFromWords([]), []);
});

test('the course read answers its lessons in order with done marks, and no done table is an empty set', async () => {
  const withDone = fake(sql => sql.includes('to_regclass') ? [{ present: true }] : sql.includes('from "lesson_done"') ? [{ lesson: 'l1' }] : courseRows(sql));
  const answer = await readCourse({ database: 'd', course: 'c', person: 'p', lesson_path: '/c/{lesson}' }, withDone.rows);
  assert.deepEqual(answer.lessons.map(lesson => [lesson.id, lesson.done, lesson.href]), [['l1', true, '/c/l1'], ['l2', false, '/c/l2']]);
  assert.equal(answer.doneCount, 1);
  assert.equal(answer.course.image, 'abcdefghijk');
  assert.deepEqual([answer.course.category, answer.course.features, answer.course.learning_objectives, answer.course.requirements, answer.course.preview_video_id], ['Masterclass', ['A', 'B'], ['C'], [], 'Gaz2qA4t3Fs']);
  const none = fake(sql => sql.includes('to_regclass') ? [{ present: false }] : courseRows(sql));
  assert.equal((await readCourse({ database: 'd', course: 'c', person: 'p' }, none.rows)).doneCount, 0);
  const anonymous = fake(courseRows);
  await readCourse({ database: 'd', course: 'c' }, anonymous.rows);
  assert.ok(anonymous.calls.every(call => !call.sql.includes('lesson_done')), 'no person named: the done table is not read');
});

test('a course that is not there is refused by name', async () => {
  await assert.rejects(readCourse({ database: 'd', course: 'x' }, fake(() => []).rows), /There is no course x/);
});

test('the lesson read answers its recording, its timed passages, the lessons around it', async () => {
  const lesson = fake(sql => sql.includes('lesson_video_links') ? [{ url: 'https://youtu.be/abcdefghijk' }]
    : sql.includes('lesson_video_words') ? [{ word: 'Hello', start: 0, end: 1 }, { word: 'there.', start: 1, end: 2 }] : courseRows(sql));
  const answer = await readLesson({ database: 'd', course: 'c', lesson: 'l1', lesson_path: '/c/{lesson}' }, lesson.rows);
  assert.equal(answer.video?.kind, 'youtube');
  assert.equal(answer.segments[0].text, 'Hello there.');
  assert.equal(answer.previous, null);
  assert.deepEqual(answer.next, { title: 'Two', href: '/c/l2' });
  await assert.rejects(readLesson({ database: 'd', course: 'c', lesson: 'nope' }, lesson.rows), /There is no lesson nope/);
});

test('a lesson with no video id reads no words', async () => {
  const lesson = fake(courseRows);
  const answer = await readLesson({ database: 'd', course: 'c', lesson: 'l2' }, lesson.rows);
  assert.deepEqual(answer.segments, []);
  assert.equal(answer.video, null);
  assert.ok(lesson.calls.every(call => !call.sql.includes('lesson_video_words')));
});

test('done marks: read needs a person; saving twice adds one row; a lesson of another course is refused', async () => {
  await assert.rejects(readDone({ database: 'd', person: '', course: 'c' }, fake(() => []).rows), /Give person/);
  assert.deepEqual(await readDone({ database: 'd', person: 'p', course: 'c' }, fake(sql => sql.includes('to_regclass') ? [{ present: false }] : []).rows), { course: 'c', done: [] });
  const first = await saveDone({ database: 'd', person: 'p', course: 'c', lesson: 'l1' }, fake(sql => sql.startsWith('select 1') ? [{ found: 1 }] : [{ added: 1 }]).rows);
  assert.deepEqual(first, { course: 'c', lesson: 'l1', done: true, saved: true });
  const again = await saveDone({ database: 'd', person: 'p', course: 'c', lesson: 'l1' }, fake(sql => sql.startsWith('select 1') ? [{ found: 1 }] : []).rows);
  assert.equal(again.saved, false);
  const insert = fake(() => []);
  await assert.rejects(saveDone({ database: 'd', person: 'p', course: 'c', lesson: 'zz' }, insert.rows), /nothing was saved/);
  assert.equal(insert.calls.length, 1, 'no insert is sent for a lesson the course does not hold');
});

test('the catalogue read answers every course in sort order (the statement turns a missing column into empty words), and renames only plain tables', async () => {
  const asked: string[] = [];
  const answer = await readCourses({ database: 'd', tables: { courses: 'ethos_courses' } }, async sql => { asked.push(sql); return [{ slug: 'a', title: 'A', short_description: 'About A', category: 'Technique', image: 'img1' }, { slug: 'b', title: 'B', short_description: '', category: '', image: '' }]; });
  assert.match(asked[0], /from "ethos_courses" order by "sort_order", "slug"$/);
  assert.deepEqual(answer.courses.map(course => [course.slug, course.short_description, course.image]), [['a', 'About A', 'img1'], ['b', '', '']]);
  await assert.rejects(readCourses({ database: 'd', tables: { courses: 'x; drop' } }, async () => []), /plain table name/);
});
