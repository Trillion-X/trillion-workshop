import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAView } from '../../compare-two-movements-side-by-side/tests/render-a-view.ts';

const at = (name: string) => new URL(`../show/${name}`, import.meta.url).pathname;
const word = (w: string, start: number, end: number) => ({ word: w, start, end });
const segments = [
  { id: 'p0', start: 0, end: 2, speaker: 'Coach', text: 'Bend your knees', words: [word('Bend', 0, 0.5), word('your', 0.5, 1), word('knees', 1, 2)] },
  { id: 'p1', start: 2.5, end: 4, speaker: 'Student', text: 'Like this' },
];
const lessonAnswer = {
  course: { slug: 'c', title: 'The Course' },
  lesson: { id: 'l2', position: 2, title: 'Second lesson', done: false },
  video: { kind: 'youtube', embedUrl: 'https://www.youtube-nocookie.com/embed/abcdefghijk' },
  segments,
  previous: { title: 'First lesson', href: '/c/l1' },
  next: { title: 'Third lesson', href: '/c/l3' },
};

test('the course lists its lessons in order as links, marks the done ones and counts them', async () => {
  const html = await renderAView(at('Course.tsx'), {
    course: { slug: 'c', title: 'The Course', description: 'About it' },
    lessons: [{ id: 'l1', position: 1, title: 'One', href: '/c/l1', done: true }, { id: 'l2', position: 2, title: 'Two', href: '/c/l2', done: false }],
    doneCount: 1,
  });
  assert.match(html, /The Course/);
  assert.match(html, /href="\/c\/l1"/);
  assert.match(html, /data-course-progress="1\/2"/);
  assert.equal((html.match(/data-done="true"/g) ?? []).length, 1);
  assert.match(html, /1 of 2 lessons done/);
  assert.doesNotMatch(html, /<script|style="[^"]*display/);
});

test('a course with no lessons and no description draws its title and an empty list', async () => {
  const html = await renderAView(at('Course.tsx'), { course: { slug: 'c', title: 'Empty', description: '' }, lessons: [], doneCount: 0 });
  assert.match(html, /Empty/);
  assert.match(html, /0 lessons/);
});

test('a YouTube lesson frames the embed address, shows the transcript and the way on', async () => {
  const html = await renderAView(at('Lesson.tsx'), lessonAnswer);
  assert.match(html, /<iframe[^>]+src="https:\/\/www\.youtube-nocookie\.com\/embed\/abcdefghijk"/);
  assert.match(html, /data-transcript-reader/);
  assert.match(html, /href="\/c\/l1"/);
  assert.match(html, /href="\/c\/l3"/);
  assert.match(html, /data-lesson-mark-done="l2"/);
});

test('a lesson with no recording and no timed words draws neither a player nor a transcript', async () => {
  const html = await renderAView(at('Lesson.tsx'), { ...lessonAnswer, video: null, segments: [], previous: null, next: null });
  assert.doesNotMatch(html, /<iframe|<video|data-transcript-reader/);
  assert.match(html, /Second lesson/);
});

test('a done lesson shows its done mark and no mark-done button', async () => {
  const html = await renderAView(at('Lesson.tsx'), { ...lessonAnswer, lesson: { ...lessonAnswer.lesson, done: true } });
  assert.match(html, /data-lesson-done/);
  assert.doesNotMatch(html, /data-lesson-mark-done/);
});

test('the transcript marks the word the recording has reached and shows speakers', async () => {
  const html = await renderAView(at('TranscriptReader.tsx'), { segments, currentTime: 0.7 });
  assert.match(html, /data-passage="p0"[^>]*data-active="true"/);
  assert.equal((html.match(/data-word-active="true"/g) ?? []).length, 1);
  assert.match(html, /Coach: /);
  assert.match(html, /Student: /);
});

test('a speaker filter keeps only that speaker\'s passages', async () => {
  const html = await renderAView(at('TranscriptReader.tsx'), { segments, speakerFilter: 'Student' });
  assert.doesNotMatch(html, /data-passage="p0"/);
  assert.match(html, /data-passage="p1"/);
});

test('edit controls are drawn for the owner only', async () => {
  const reader = await renderAView(at('TranscriptReader.tsx'), { segments, currentTime: 0.7 });
  const owner = await renderAView(at('TranscriptReader.tsx'), { segments, currentTime: 0.7, viewer: { isOwner: true } });
  assert.doesNotMatch(reader, /Name Coach|Split before/);
  assert.match(owner, /Name Coach/);
  assert.match(owner, /Split before this word/);
});

test('a passage with no timed words is spread evenly over its time, so the mark still moves through it', async () => {
  const early = await renderAView(at('TranscriptReader.tsx'), { segments, currentTime: 2.6 });
  assert.match(early, /data-passage="p1"[^>]*data-active="true"/);
  assert.equal((early.match(/data-word-active="true"/g) ?? []).length, 1);
  const between = await renderAView(at('TranscriptReader.tsx'), { segments, currentTime: 2.2 });
  assert.match(between, /data-passage="p0"[^>]*data-active="true"/, 'between two passages the one just spoken stays marked');
});

test('a file recording is handed to the shared player, which draws after it arrives, never as a frame', async () => {
  const html = await renderAView(at('Lesson.tsx'), { ...lessonAnswer, video: { kind: 'file', url: '/files/l.mp4' } });
  assert.doesNotMatch(html, /<iframe/);
  assert.match(html, /Second lesson/);
});

test('the catalogue draws a linked card per course, a picture only when it has one, and the heading', async () => {
  const courses = [{ slug: 'first-principles', title: 'First principles', short_description: 'How it works.', category: 'Technique', image: 'abc' }, { slug: 'the greats', title: 'The greats', short_description: '', category: '', image: '' }];
  const html = await renderAView(at('CourseList.tsx'), { courses, heading: 'Courses', base_path: '/courses/', image_template: 'https://img.example/{image}.jpg' });
  assert.match(html, /Courses/);
  assert.match(html, /href="\/courses\/first-principles"/);
  assert.match(html, /href="\/courses\/the%20greats"/);
  assert.equal((html.match(/<img/g) ?? []).length, 1);
  assert.match(html, /src="https:\/\/img\.example\/abc\.jpg"/);
  assert.match(await renderAView(at('CourseList.tsx'), { courses: [], heading: 'Courses' }), /Courses/);
});

test('a course draws its picture at the address the template makes of its picture id, and none without one', async () => {
  const lessons = [{ id: 'l1', position: 1, title: 'One', href: '/c/l1', done: false }];
  const drawn = await renderAView(at('Course.tsx'), { course: { slug: 'c', title: 'The Course', description: '', image: 'abcdefghijk' }, lessons, doneCount: 0, image_template: 'https://i.ytimg.com/vi/{image}/hqdefault.jpg' });
  assert.match(drawn, /https:\/\/i\.ytimg\.com\/vi\/abcdefghijk\/hqdefault\.jpg/);
  assert.doesNotMatch(await renderAView(at('Course.tsx'), { course: { slug: 'c', title: 'The Course', description: '', image: '' }, lessons, doneCount: 0, image_template: 'https://i.ytimg.com/vi/{image}/hqdefault.jpg' }), /ytimg/);
});

test('a course page draws its eyebrow, its three cards from the course row lists, a heading over the lessons, and the preview frame when there is no picture', async () => {
  const lessons = [{ id: 'l1', position: 1, title: 'One', href: '/c/l1', done: false }];
  const course = { slug: 'c', title: 'The Course', description: 'About', category: 'Masterclass', short_description: 'A short line.', features: ['Deep Dive'], learning_objectives: ['Understand the swing', 'See the principles'], requirements: [], preview_video_id: 'Gaz2qA4t3Fs', image: '' };
  const html = await renderAView(at('Course.tsx'), { course, lessons, doneCount: 0 });
  assert.match(html, /data-course-eyebrow[^>]*>Masterclass course · 1 lesson</);
  assert.match(html, /What you will learn/);
  assert.match(html, /Understand the swing/);
  assert.match(html, /What is in it/);
  assert.doesNotMatch(html, /Before you start/, 'an empty list draws no card');
  assert.match(html, /data-course-lessons-heading[^>]*>A short line\./);
  assert.match(html, /youtube-nocookie\.com\/embed\/Gaz2qA4t3Fs/);
  assert.doesNotMatch(await renderAView(at('Course.tsx'), { course: { slug: 'c', title: 'Bare', description: '' }, lessons, doneCount: 0 }), /youtube|data-course-eyebrow/);
});

test('a title with a page: id is plain text, not a link, and a real lesson still links', async () => {
  const html = await renderAView(at('Course.tsx'), {
    course: { slug: 'c', title: 'The Course', description: '' },
    lessons: [{ id: 'l1', position: 1, title: 'Real', href: '/c/l1', done: false }, { id: 'page:c:2', position: 2, title: 'Only named', href: '/c/page:c:2', done: false }],
    doneCount: 0,
  });
  assert.match(html, /href="\/c\/l1"/);
  assert.doesNotMatch(html, /page:c:2"[^>]*>\s*<a|href="\/c\/page/);
  assert.match(html, /Only named/);
});

test('the other courses draw as links with their lesson counts, leave out the current course, and draw nothing when none are left', async () => {
  const courses = [{ slug: 'a', title: 'A course', short_description: '', category: '', image: '', lesson_count: 26 }, { slug: 'b', title: 'B course', short_description: '', category: '', image: '', lesson_count: 1 }];
  const html = await renderAView(at('CourseLinks.tsx'), { courses, heading: 'The other courses', base_path: '/courses', current: 'b' });
  assert.match(html, /The other courses/);
  assert.match(html, /href="\/courses\/a"/);
  assert.match(html, /26 lessons/);
  assert.doesNotMatch(html, /B course/);
  assert.doesNotMatch(await renderAView(at('CourseLinks.tsx'), { courses: [courses[1]], current: 'b' }), /data-course-links/);
  assert.match(await renderAView(at('CourseLinks.tsx'), { courses: [courses[1]], current: 'x' }), /1 lesson</);
});
