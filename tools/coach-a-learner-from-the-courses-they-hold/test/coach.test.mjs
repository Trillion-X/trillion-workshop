// tools/coach-a-learner-from-the-courses-they-hold/test/coach.test.mjs
//
// The coach's three answers on real-shaped tables (PGlite, made-up rows, one database per held connection). The settings come
// from a coach_settings row in the access database, as the run reads them. A learner sees only the courses their held access
// opens; a non-holder, another issuer's caller, an unverified email and a lesson outside their courses are refused; a learner
// asking for another learner's course finds nothing; search returns only held lessons plus published articles; the most_words cap
// holds; a school with no settings is refused as not set up. The rows' descriptors are checked against the code's fixed
// connections: each mounts the three connections under the names given there.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { answer, CoachRefusal, HELD_CONNECTIONS, issuerTag, settingsOf } from '../do-work/coach.mjs';

const folder = new URL('../', import.meta.url);
const rows = JSON.parse(readFileSync(new URL('what-this-tool-does-and-how-to-run-it.json', folder), 'utf8'));

// The table and column names a school's settings give (made-up names here).
const names = {
  user: { table: 'sign_in_users', id: 'id', email: 'email', verified: 'email_verified' },
  offers: { table: 'offers' },
  payment_events: { table: 'payment_events', email: 'customer_email', provider_object_ref: 'provider_object_ref', subscription_id: 'subscription_id', occurred_at: 'occurred_at' },
  access_grants: { table: 'access_grants', id: 'id', person_id: 'person_id', email: 'email', access_ref: 'access_ref', starts_at: 'starts_at', ends_at: 'ends_at' },
  people: { table: 'people', id: 'id', email: 'email' },
  transcript_segments: { table: 'transcript_segments', ref: 'transcript_ref', start_ms: 'start_ms', text: 'text' },
  courses: { table: 'courses', id: 'id', title: 'title', sort_order: 'sort_order', access_refs: 'access_refs' },
  lessons: { table: 'lessons', course_id: 'course_id', lesson_id: 'lesson_id', position: 'position', title: 'title', video_id: 'video_id', collection: 'collection' },
  videos: { table: 'videos', id: 'id', video_url: 'video_url', transcript: 'transcript' },
  words: { table: 'lesson_words', video_id: 'video_id', n: 'n', word: 'word', start_s: 'start_s' },
  passages: { table: 'passages', id: 'id', body: 'body', collection: 'collection' },
  articles: { table: 'articles', path: 'path', title: 'title', body: 'body', published: 'published' },
};
const SETTINGS = {
  issuer_url: 'https://school.example.test',
  required_access_ref: 'access:coach',
  statement_timeout_ms: 15000,
  most_words: 4000,
  most_matches: { default: 20, cap: 50 },
  transcript_ref: { from_video_url: '(?:youtu\\.be/|[?&]v=)([A-Za-z0-9_-]{11})', template: 'record:transcript-entry:youtube-{id}' },
  names,
};

// The names as SQL: a table quoted, a column quoted.
const T = key => `"${names[key].table}"`;
const C = (key, field) => `"${names[key][field]}"`;
const COACH = SETTINGS.required_access_ref;

const SIGN_INS = `
create table ${T('user')} (${C('user', 'id')} text primary key, name text, ${C('user', 'email')} text, ${C('user', 'verified')} boolean not null default false);
insert into ${T('user')} (${C('user', 'id')}, name, ${C('user', 'email')}, ${C('user', 'verified')}) values
  ('learner-a', 'Student A', 'learner-a@example.test', true),
  ('learner-b', 'Student B', 'learner-b@example.test', true),
  ('learner-u', 'Student U', 'learner-u@example.test', false),
  ('learner-d', 'Student D', 'learner-d@example.test', true),
  ('learner-c', 'Student C', 'learner-c@example.test', true);`;

const RUNS = `
create table ${T('offers')} (id text primary key, label text, access_refs jsonb, price_options jsonb, for_sale boolean);
create table ${T('payment_events')} (id text primary key, event_id text, ${C('payment_events', 'occurred_at')} timestamptz not null,
  event_kind text not null, offer_id text, ${C('payment_events', 'email')} text, ${C('payment_events', 'provider_object_ref')} text,
  ${C('payment_events', 'subscription_id')} text, payment_status text, attributes jsonb);
create table ${T('people')} (${C('people', 'id')} text primary key, ${C('people', 'email')} text not null);
create table ${T('access_grants')} (${C('access_grants', 'id')} text primary key, ${C('access_grants', 'email')} text,
  offer_id text, ${C('access_grants', 'access_ref')} text, ${C('access_grants', 'starts_at')} timestamptz,
  ${C('access_grants', 'ends_at')} timestamptz, made_at timestamptz, ${C('access_grants', 'person_id')} text);
create table ${T('transcript_segments')} (id text primary key, ${C('transcript_segments', 'ref')} text not null,
  ${C('transcript_segments', 'start_ms')} text, end_ms text, ${C('transcript_segments', 'text')} text, speaker text);
create table coach_settings (id text primary key, settings jsonb not null);
insert into ${T('offers')} (id, label, access_refs, price_options, for_sale) values
  ('offer:alpha', 'Alpha', '["${COACH}","access:alpha"]', '[{"id":"price:alpha","amount_cents":1000}]', true),
  ('offer:beta', 'Beta', '["${COACH}","access:beta"]', '[{"id":"price:beta","amount_cents":1000}]', true),
  ('offer:alpha-only', 'Alpha only', '["access:alpha"]', '[{"id":"price:alpha-only","amount_cents":500}]', true);
insert into ${T('payment_events')} (id, event_id, ${C('payment_events', 'occurred_at')}, event_kind, offer_id, ${C('payment_events', 'email')}, payment_status, attributes) values
  ('pe-a', 'evt_a', '2026-01-05T00:00:00Z', 'payment.confirmed', 'offer:alpha', 'learner-a@example.test', 'paid',
    '{"provider_event_id":"evt_a","customer_email":"learner-a@example.test","offer_id":"offer:alpha","payment_intent_ref":"pi_a","payment_status":"paid"}'),
  ('pe-b', 'evt_b', '2026-01-06T00:00:00Z', 'payment.confirmed', 'offer:beta', 'learner-b@example.test', 'paid',
    '{"provider_event_id":"evt_b","customer_email":"learner-b@example.test","offer_id":"offer:beta","payment_intent_ref":"pi_b","payment_status":"paid"}'),
  ('pe-u', 'evt_u', '2026-01-06T00:00:00Z', 'payment.confirmed', 'offer:alpha', 'learner-u@example.test', 'paid',
    '{"provider_event_id":"evt_u","customer_email":"learner-u@example.test","offer_id":"offer:alpha","payment_intent_ref":"pi_u","payment_status":"paid"}'),
  ('pe-d', 'evt_d', '2026-01-07T00:00:00Z', 'payment.confirmed', 'offer:alpha-only', 'learner-d@example.test', 'paid',
    '{"provider_event_id":"evt_d","customer_email":"learner-d@example.test","offer_id":"offer:alpha-only","payment_intent_ref":"pi_d","payment_status":"paid"}');
insert into ${T('transcript_segments')} (id, ${C('transcript_segments', 'ref')}, ${C('transcript_segments', 'start_ms')}, end_ms, ${C('transcript_segments', 'text')}, speaker) values
  ('seg-1', 'record:transcript-entry:youtube-CCCCCCCCCCC', '4200', '4900', 'Keep the racket grip relaxed.', 'Coach'),
  ('seg-2', 'record:transcript-entry:youtube-BBBBBBBBBBB', '500', '900', 'A beta course note.', 'Coach');`;

const CONTENT = `
create table ${T('courses')} (${C('courses', 'id')} text primary key, ${C('courses', 'sort_order')} integer, ${C('courses', 'title')} text, ${C('courses', 'access_refs')} jsonb);
create table ${T('videos')} (${C('videos', 'id')} text primary key, ${C('videos', 'video_url')} text, ${C('videos', 'transcript')} text);
create table ${T('lessons')} (${C('lessons', 'course_id')} text not null references ${T('courses')}(${C('courses', 'id')}),
  ${C('lessons', 'lesson_id')} text not null, ${C('lessons', 'position')} integer not null, ${C('lessons', 'title')} text,
  ${C('lessons', 'video_id')} text references ${T('videos')}(${C('videos', 'id')}), ${C('lessons', 'collection')} text,
  primary key (${C('lessons', 'course_id')}, ${C('lessons', 'lesson_id')}));
create table ${T('words')} (${C('words', 'video_id')} text not null, ${C('words', 'n')} integer not null, ${C('words', 'word')} text not null,
  ${C('words', 'start_s')} numeric, end_s numeric, primary key (${C('words', 'video_id')}, ${C('words', 'n')}));
create table ${T('passages')} (${C('passages', 'id')} text primary key, title text, ${C('passages', 'body')} text, ${C('passages', 'collection')} text);
create table ${T('articles')} (${C('articles', 'path')} text primary key, title text, description text, ${C('articles', 'body')} text,
  ${C('articles', 'published')} timestamptz, listed numeric);
insert into ${T('courses')} (${C('courses', 'id')}, ${C('courses', 'sort_order')}, ${C('courses', 'title')}, ${C('courses', 'access_refs')}) values
  ('course-alpha', 1, 'Alpha course', '["access:alpha"]'),
  ('course-beta', 2, 'Beta course', '["access:beta"]');
insert into ${T('videos')} (${C('videos', 'id')}, ${C('videos', 'video_url')}, ${C('videos', 'transcript')}) values
  ('v-1', 'https://youtu.be/AAAAAAAAAAA', null),
  ('v-2', 'https://youtu.be/BBBBBBBBBBB', null),
  ('v-3', 'https://youtu.be/CCCCCCCCCCC', null);
insert into ${T('lessons')} (${C('lessons', 'course_id')}, ${C('lessons', 'lesson_id')}, ${C('lessons', 'position')}, ${C('lessons', 'title')}, ${C('lessons', 'video_id')}, ${C('lessons', 'collection')}) values
  ('course-alpha', 'l-1', 1, 'Accepting Invariants', 'v-1', null),
  ('course-alpha', 'l-2', 2, 'North Star talk', null, 'passages-alpha'),
  ('course-alpha', 'l-3', 3, 'Racket grip drill', 'v-3', null),
  ('course-beta', 's-1', 1, 'Beta course toss', 'v-2', null);
insert into ${T('words')} (${C('words', 'video_id')}, ${C('words', 'n')}, ${C('words', 'word')}, ${C('words', 'start_s')}, end_s) values
  ('v-1', 0, 'Welcome', 0, 0.4), ('v-1', 1, 'to', 0.4, 0.5), ('v-1', 2, 'the', 0.5, 0.6), ('v-1', 3, 'first', 0.6, 0.9),
  ('v-1', 4, 'lesson.', 0.9, 1.5), ('v-1', 5, 'Keep', 1.5, 1.8), ('v-1', 6, 'the', 1.8, 1.9), ('v-1', 7, 'grip', 1.9, 2.2),
  ('v-1', 8, 'loose.', 2.2, 2.8), ('v-1', 9, 'Hold', 2.8, 3.0), ('v-1', 10, 'the', 3.0, 3.1), ('v-1', 11, 'racket', 3.1, 3.5),
  ('v-1', 12, 'low.', 3.5, 4.0),
  ('v-2', 0, 'Beta', 10, 10.4), ('v-2', 1, 'toss', 10.4, 10.9), ('v-2', 2, 'height.', 10.9, 11.5);
insert into ${T('passages')} (${C('passages', 'id')}, title, ${C('passages', 'body')}, ${C('passages', 'collection')}) values
  ('p-1', 'North star', 'The north star: every stroke starts from one question.', 'passages-alpha'),
  ('p-2', 'Grip passage', 'The grip is the first thing to fix in any stroke.', 'passages-alpha'),
  ('p-3', 'Beta passage', 'Beta toss height notes.', 'passages-beta');
insert into ${T('articles')} (${C('articles', 'path')}, title, description, ${C('articles', 'body')}, ${C('articles', 'published')}, listed) values
  ('/articles/grip', 'Grip basics', 'Grip', 'Every stroke starts with the grip.', '2026-01-02T00:00:00Z', 1),
  ('/articles/future', 'Coming soon', 'Later', 'grip coming later', '2999-01-01T00:00:00Z', 1),
  ('/articles/draft', 'Draft', 'Draft', 'grip draft', null, 0);`;

/** A PGlite database with the given schema, as the coach reads it: query(text, params) → rows. */
async function open(sql, params = null) {
  const db = new PGlite();
  await db.exec(sql);
  if (params) await db.query(params[0], params[1]);
  return { query: async (text, values = []) => (await db.query(text, values)).rows };
}

const dbs = {};
let live;
before(async () => {
  dbs.sign_ins = await open(SIGN_INS);
  dbs.runs = await open(RUNS, ["insert into coach_settings (id, settings) values ('coach', $1)", [JSON.stringify(SETTINGS)]]);
  dbs.content = await open(CONTENT);
  live = await settingsOf(dbs.runs, 'coach_settings');
});

const caller = sub => `${issuerTag(SETTINGS.issuer_url)}_${sub}`;
const ask = (operation, input, custom = live) => answer(operation, input, dbs, custom);
const refusal = (promise, pattern) => assert.rejects(promise, error => error instanceof CoachRefusal && pattern.test(error.message));

test('the school settings are read from the coach_settings row; a school with none is refused as not set up', async () => {
  assert.equal(live.issuer_url, SETTINGS.issuer_url);
  assert.equal(live.names.courses.table, 'courses');
  const noTable = await open('select 1');
  await refusal(settingsOf(noTable, 'coach_settings'), /This school has not set up its coach yet/);
  const noRow = await open('create table coach_settings (id text primary key, settings jsonb not null);');
  await refusal(settingsOf(noRow, 'coach_settings'), /This school has not set up its coach yet/);
  const partial = await open(`create table coach_settings (id text primary key, settings jsonb not null);
    insert into coach_settings (id, settings) values ('coach', '{"issuer_url":"https://school.example.test"}');`);
  await refusal(settingsOf(partial, 'coach_settings'), /This school has not set up its coach yet/);
});

test('the issuer tag is the first 24 hex characters of BLAKE3 of the issuer URL', () => {
  assert.match(issuerTag(SETTINGS.issuer_url), /^[0-9a-f]{24}$/);
  assert.notEqual(issuerTag(SETTINGS.issuer_url), issuerTag('https://other.example.test'));
});

test('an admitted holder sees only the courses the held access opens', async () => {
  const result = await ask('listTheLessonsIHold', { grant_person: caller('learner-a') });
  assert.deepEqual(result.courses.map(course => course.course_id), ['course-alpha']);
  assert.deepEqual(result.courses[0].lessons.map(lesson => lesson.lesson_id), ['l-1', 'l-2', 'l-3']);
  const byId = Object.fromEntries(result.courses[0].lessons.map(lesson => [lesson.lesson_id, lesson]));
  assert.equal(byId['l-1'].video_link, 'https://youtu.be/AAAAAAAAAAA');
  assert.equal(byId['l-1'].has_transcript, true);
  assert.equal(byId['l-2'].video_link, null);
  assert.equal(byId['l-2'].has_transcript, false);
  assert.equal(byId['l-3'].has_transcript, true, 'a lesson with no words but a transcript segment has a transcript');
  assert.ok(!JSON.stringify(result).includes('course-beta'), 'a course the learner does not hold is not named');
});

test('a holder reads a lesson with its passages and timed transcript, start seconds included', async () => {
  const lesson = await ask('readALessonIHold', { grant_person: caller('learner-a'), lesson_id: 'l-1' });
  assert.equal(lesson.title, 'Accepting Invariants');
  assert.equal(lesson.video_link, 'https://youtu.be/AAAAAAAAAAA');
  assert.deepEqual(lesson.transcript, [
    { start_s: 0, text: 'Welcome to the first lesson.' },
    { start_s: 1.5, text: 'Keep the grip loose.' },
    { start_s: 2.8, text: 'Hold the racket low.' },
  ]);
  assert.equal(lesson.truncated, false);
});

test('a learner with no coach ref, or no purchase, is refused', async () => {
  await refusal(ask('listTheLessonsIHold', { grant_person: caller('learner-c') }), /Your school has not given you the AI coach/);
  await refusal(ask('readALessonIHold', { grant_person: caller('learner-d'), lesson_id: 'l-1' }), /Your school has not given you the AI coach/);
});

test('a caller whose issuer tag is another issuer is refused', async () => {
  const foreign = `${issuerTag('https://other.example.test')}_learner-a`;
  await refusal(ask('listTheLessonsIHold', { grant_person: foreign }), /not from this school/);
});

test('a caller with no grant_person, or a person not known, is refused in plain words', async () => {
  await refusal(ask('listTheLessonsIHold', {}), /did not say who you are/);
  await refusal(ask('listTheLessonsIHold', { grant_person: `${issuerTag(SETTINGS.issuer_url)}_` }), /did not say who you are/);
  await refusal(ask('listTheLessonsIHold', { grant_person: caller('learner-nobody') }), /We do not know this person/);
});

test('an unverified email is refused even with a purchase on it', async () => {
  await refusal(ask('listTheLessonsIHold', { grant_person: caller('learner-u') }), /not verified/);
});

test('a lesson outside the learner courses is refused', async () => {
  await refusal(ask('readALessonIHold', { grant_person: caller('learner-a'), lesson_id: 's-1' }), /not in your courses/);
  await refusal(ask('readALessonIHold', { grant_person: caller('learner-a') }), /Say which lesson to read/);
});

test('two students with different courses: each sees only their own, and neither finds the other course by read or by search', async () => {
  const a = await ask('listTheLessonsIHold', { grant_person: caller('learner-a') });
  const b = await ask('listTheLessonsIHold', { grant_person: caller('learner-b') });
  assert.deepEqual(a.courses.map(course => course.course_id), ['course-alpha']);
  assert.deepEqual(b.courses.map(course => course.course_id), ['course-beta']);

  // Student A asks for student B's lesson, by read and by search.
  await refusal(ask('readALessonIHold', { grant_person: caller('learner-a'), lesson_id: 's-1' }), /not in your courses/);
  const aSearch = await ask('searchWhatMyCoachTeaches', { grant_person: caller('learner-a'), query: 'toss' });
  assert.deepEqual(aSearch.matches, [], 'student A finds nothing in student B course');
  const aTitle = await ask('searchWhatMyCoachTeaches', { grant_person: caller('learner-a'), query: 'beta' });
  assert.deepEqual(aTitle.matches, [], 'a title of student B course is not found either');

  // Student B asks for student A's lesson, by read; and student B's own search finds only B's course.
  await refusal(ask('readALessonIHold', { grant_person: caller('learner-b'), lesson_id: 'l-1' }), /not in your courses/);
  const bSearch = await ask('searchWhatMyCoachTeaches', { grant_person: caller('learner-b'), query: 'toss' });
  assert.ok(bSearch.matches.some(match => match.kind === 'transcript' && match.lesson_id === 's-1' && match.start_s === 10));
  assert.ok(bSearch.matches.every(match => match.lesson_id === undefined || match.lesson_id === 's-1'));
});

test('search returns only held lessons plus published articles, with the lesson, the snippet and the start second', async () => {
  const result = await ask('searchWhatMyCoachTeaches', { grant_person: caller('learner-a'), query: 'grip' });
  const articles = result.matches.filter(match => match.kind === 'article').map(match => match.path);
  assert.deepEqual(articles, ['/articles/grip'], 'unpublished and future articles are not searched');
  assert.ok(result.matches.some(match => match.kind === 'transcript' && match.lesson_id === 'l-1' && match.start_s === 1.5));
  assert.ok(result.matches.some(match => match.kind === 'transcript' && match.lesson_id === 'l-3' && match.start_s === 4.2));
  assert.ok(result.matches.some(match => match.kind === 'passage' && match.lesson_id === 'l-2'));
  assert.ok(result.matches.some(match => match.kind === 'lesson-title' && match.lesson_id === 'l-3'));
  assert.ok(result.matches.every(match => match.lesson_id === undefined || ['l-1', 'l-2', 'l-3'].includes(match.lesson_id)));
});

test('search caps the answer at most, and refuses a most out of range', async () => {
  const one = await ask('searchWhatMyCoachTeaches', { grant_person: caller('learner-a'), query: 'grip', most: 1 });
  assert.equal(one.matches.length, 1);
  assert.equal(one.truncated, true);
  await refusal(ask('searchWhatMyCoachTeaches', { grant_person: caller('learner-a'), query: 'grip', most: 0 }), /most must be a whole number/);
});

test('the most_words cap cuts the transcript at a whole line, and says so', async () => {
  const tight = await ask('readALessonIHold', { grant_person: caller('learner-a'), lesson_id: 'l-1' }, { ...live, most_words: 8 });
  assert.deepEqual(tight.transcript.map(line => line.start_s), [0], 'the second line would pass 8 words');
  assert.equal(tight.truncated, true);
  const none = await ask('readALessonIHold', { grant_person: caller('learner-a'), lesson_id: 'l-1' }, { ...live, most_words: 4 });
  assert.deepEqual(none.transcript, []);
  assert.equal(none.truncated, true);
});

test('an operation that is not one of the three is refused', async () => {
  await assert.rejects(answer('dropEverything', { grant_person: caller('learner-a') }, dbs, live), /there is no operation dropEverything/);
});

test('each row mounts the three held connections under the names the code fixes, and runs one of the three operations', () => {
  const expected = Object.fromEntries(Object.values(HELD_CONNECTIONS).map(({ fd, held_name }) => [fd, held_name]));
  assert.deepEqual(expected, { 3: 'coach-sign-ins-connection', 4: 'coach-access-connection', 5: 'coach-lessons-connection' });
  const tools = rows.records.map(record => record.payload);
  assert.equal(tools.length, 3);
  for (const tool of tools) {
    const mounts = Object.fromEntries(tool.invoke.key.map(mount => [mount.fd, mount.secret_name]));
    assert.deepEqual(mounts, expected, `${tool.id} mounts the connections the code names`);
    assert.ok(tool.invoke.run.at(-1).match(/^(listTheLessonsIHold|readALessonIHold|searchWhatMyCoachTeaches)$/), `${tool.id} names its operation`);
    assert.ok(!tool.invoke.run.some(part => part.endsWith('.json')), `${tool.id} reads no settings file: the settings are the school's row`);
    assert.ok(Object.hasOwn(tool.invoke.packages ?? {}, 'pg'), `${tool.id} ships pg with its pinned tarball`);
  }
  assert.deepEqual(readdirSync(new URL('do-work/', folder)).sort(), ['coach.mjs', 'run.mjs']);
});
