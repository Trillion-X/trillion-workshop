// tools/coach-a-learner-from-the-courses-they-hold/do-work/coach.mjs
//
// The three answers a learner's own AI gets from a school's engine, each only from the courses that learner's held
// access opens:
//   listTheLessonsIHold       the open courses and their lessons (id, title, video link, whether there is a transcript)
//   readALessonIHold          one open lesson: its title, video link, passages and timed transcript (capped by most_words)
//   searchWhatMyCoachTeaches  text search over the open lessons' titles, passages and timed transcripts, plus the published articles
//
// Generic: every table and column name, the issuer, the access ref a learner must hold, the transcript-id rule and the caps come
// from the school's own settings row (read at the start of each run by settingsOf). This file names no school.
//
// Who is asking: the engine admits the caller through a team share grant with identity "self" and puts the caller's id in
// `grant_person`, the form `<issuer tag>_<sub>`. The issuer tag is the first 24 hex characters of BLAKE3 of the issuer URL
// (trillion-rust src/account/issuers.rs, issuer_tag). The sign-in store names the person by `sub`; an unverified email is refused;
// read-data/who-holds-access.mjs (the paid-access function the school's own site calls) answers the access the person holds now.
//
// Every read is parameterized SQL inside a read-only transaction on each held connection. A refusal is a CoachRefusal whose
// message is plain words for the learner. Nothing here returns, prints or logs a connection string.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { heldAccessOfRequest } from '../../paid-access/read-data/who-holds-access.mjs';

/** A refusal the learner's AI shows as it is: plain words, nothing secret. */
export class CoachRefusal extends Error {}

const refuse = message => { throw new CoachRefusal(message); };

/** The three connections a run holds: the descriptor each is read from, and the vault name the row mounts it under. */
export const HELD_CONNECTIONS = {
  sign_ins: { fd: 3, held_name: 'coach-sign-ins-connection' },
  runs: { fd: 4, held_name: 'coach-access-connection' },
  content: { fd: 5, held_name: 'coach-lessons-connection' },
};

const NOT_SET_UP = 'This school has not set up its coach yet.';

/**
 * The school's settings: the one row of `table` with id 'coach' in the access database, its settings jsonb. A missing table, a
 * missing row or settings without the fields the coach needs are refused as not set up.
 */
export async function settingsOf(access, table) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`"${table}" is not a plain table name`);
  let rows;
  try {
    rows = await access.query(`SELECT settings FROM "${table}" WHERE id = $1`, ['coach']);
  } catch (error) {
    if (error.code === '42P01') refuse(NOT_SET_UP);
    throw error;
  }
  const settings = rows[0]?.settings;
  const usable = Boolean(settings) && typeof settings === 'object' && typeof settings.issuer_url === 'string'
    && typeof settings.required_access_ref === 'string' && Number.isInteger(settings.statement_timeout_ms)
    && Number.isInteger(settings.most_words) && settings.most_matches && settings.transcript_ref && settings.names && typeof settings.names === 'object';
  if (!usable) refuse(NOT_SET_UP);
  return settings;
}

/** The first 24 hex characters of BLAKE3 of the issuer URL: the tag every caller id of that issuer starts with. */
export const issuerTag = url => bytesToHex(blake3(utf8ToBytes(url))).slice(0, 24);

/** The settings' table and column names, quoted as identifiers. Only plain names pass. */
export function schema(settings) {
  const names = settings.names;
  const quoted = name => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`"${name}" in the settings is not a plain table or column name`);
    return `"${name}"`;
  };
  return {
    T: key => quoted(names[key].table),
    C: (key, field) => {
      if (!(field in names[key])) throw new Error(`the settings names ${key} without ${field}`);
      return quoted(names[key][field]);
    },
  };
}

/** The sub of a caller id whose issuer is the settings' issuer; any other caller is refused. */
export function subjectOf(grantPerson, settings) {
  const cut = typeof grantPerson === 'string' ? grantPerson.indexOf('_') : -1;
  if (cut < 0 || cut === grantPerson.length - 1) refuse('Your school did not say who you are, so the coach cannot open any lessons.');
  if (grantPerson.slice(0, cut) !== issuerTag(settings.issuer_url)) refuse('This sign-in is not from this school, so the coach cannot open any lessons.');
  return grantPerson.slice(cut + 1);
}

/** The verified person the caller is, with the access refs they hold now. Refused unless they hold the coach's required ref. */
export async function admit(input, dbs, settings) {
  const sub = subjectOf(input.grant_person, settings);
  const S = schema(settings);
  const [person] = await dbs.sign_ins.query(`SELECT ${S.C('user', 'email')} AS email, ${S.C('user', 'verified')} AS verified FROM ${S.T('user')} WHERE ${S.C('user', 'id')} = $1`, [sub]);
  if (!person || !person.email) refuse('We do not know this person, so the coach cannot open any lessons.');
  if (person.verified !== true) refuse('Your email is not verified yet, so the coach cannot open any lessons.');
  const email = String(person.email).toLowerCase();
  const held = await heldAccessOf(email, dbs.runs, settings);
  if (!held.has(settings.required_access_ref)) refuse('Your school has not given you the AI coach.');
  return { email, held };
}

/** What one verified email holds now: its payments (and every event on the same purchases) and its hand grants, folded by the paid-access function. */
export async function heldAccessOf(email, runs, settings) {
  const S = schema(settings);
  const N = settings.names;
  const pay = field => S.C('payment_events', field);
  // One after another: the three reads share one connection, which takes one query at a time.
  const offers = await runs.query(`SELECT * FROM ${S.T('offers')}`);
  const events = await runs.query(`SELECT * FROM ${S.T('payment_events')} WHERE lower(${pay('email')}) = $1
      OR ${pay('provider_object_ref')} IN (SELECT ${pay('provider_object_ref')} FROM ${S.T('payment_events')} WHERE lower(${pay('email')}) = $1 AND ${pay('provider_object_ref')} IS NOT NULL)
      OR ${pay('subscription_id')} IN (SELECT ${pay('subscription_id')} FROM ${S.T('payment_events')} WHERE lower(${pay('email')}) = $1 AND ${pay('subscription_id')} IS NOT NULL)`, [email]);
  const grants = await runs.query(`SELECT g.* FROM ${S.T('access_grants')} g LEFT JOIN ${S.T('people')} p ON p.${S.C('people', 'id')} = g.${S.C('access_grants', 'person_id')}
      WHERE lower(coalesce(p.${S.C('people', 'email')}, g.${S.C('access_grants', 'email')})) = $1`, [email]);
  const paymentEvents = events.map(row => ({
    ...row,
    occurred_at: row[N.payment_events.occurred_at] ? new Date(row[N.payment_events.occurred_at]).toISOString() : null,
    attributes: { ...row.attributes, customer_email: row[N.payment_events.email] ? String(row[N.payment_events.email]).toLowerCase() : row.attributes?.customer_email },
  }));
  const accessGrants = grants.filter(grant => grant[N.access_grants.access_ref]).map(grant => ({
    kind: 'license_access',
    subject: email,
    object: grant[N.access_grants.access_ref],
    material: {
      grant_ref: grant[N.access_grants.id],
      ...(grant[N.access_grants.ends_at] ? { valid_from_ms: new Date(grant[N.access_grants.starts_at]).getTime(), expires_at_ms: new Date(grant[N.access_grants.ends_at]).getTime() } : {}),
    },
  }));
  return new Set(heldAccessOfRequest({ subject: email, email_verified: true, offers, payment_events: paymentEvents, grants: accessGrants }, { nowMs: Date.now() }).held_access_refs);
}

/** The courses the held access opens, in the school's order, each with its lessons in lesson order. */
export async function openCourses(content, held, settings) {
  const S = schema(settings);
  const courses = (await content.query(`SELECT ${S.C('courses', 'id')} AS id, ${S.C('courses', 'title')} AS title, ${S.C('courses', 'access_refs')} AS access_refs
    FROM ${S.T('courses')} ORDER BY ${S.C('courses', 'sort_order')}`)).filter(course => (course.access_refs ?? []).some(ref => held.has(ref)));
  if (!courses.length) return [];
  const rows = await content.query(`SELECT l.${S.C('lessons', 'course_id')} AS course_id, l.${S.C('lessons', 'lesson_id')} AS lesson_id, l.${S.C('lessons', 'title')} AS title,
      l.${S.C('lessons', 'collection')} AS collection, l.${S.C('lessons', 'video_id')} AS video_id, v.${S.C('videos', 'video_url')} AS video_url,
      v.${S.C('videos', 'transcript')} AS transcript,
      EXISTS (SELECT 1 FROM ${S.T('words')} w WHERE w.${S.C('words', 'video_id')} = l.${S.C('lessons', 'video_id')}) AS has_words
    FROM ${S.T('lessons')} l LEFT JOIN ${S.T('videos')} v ON v.${S.C('videos', 'id')} = l.${S.C('lessons', 'video_id')}
    WHERE l.${S.C('lessons', 'course_id')} = ANY($1) ORDER BY l.${S.C('lessons', 'course_id')}, l.${S.C('lessons', 'position')}`, [courses.map(course => course.id)]);
  return courses
    .map(course => ({
      id: course.id,
      title: course.title,
      lessons: rows.filter(row => row.course_id === course.id).map(row => ({
        id: row.lesson_id, title: row.title, collection: row.collection ?? null, video_id: row.video_id ?? null,
        video_url: row.video_url ?? null, transcript: row.transcript ?? null, has_words: Boolean(row.has_words),
      })),
    }))
    .filter(course => course.lessons.length);
}

/** The transcript ref a video's segments are kept under in the runs database, from its video link (settings transcript_ref). */
const transcriptRefOf = (videoUrl, settings) => {
  const match = new RegExp(settings.transcript_ref.from_video_url).exec(videoUrl ?? '');
  return match ? settings.transcript_ref.template.replace('{id}', match[1]) : null;
};

/** The timed sentences of the videos' words (lesson_video_words): a sentence ends at a word ending in . ? or !. */
export async function timedLines(content, settings, videoIds, { needle = null, limit = null } = {}) {
  if (!videoIds.length) return [];
  const S = schema(settings);
  const video = S.C('words', 'video_id'), n = S.C('words', 'n'), word = S.C('words', 'word'), at = S.C('words', 'start_s');
  const params = [videoIds];
  const filters = [];
  if (needle !== null) { params.push(needle); filters.push(`strpos(lower(s.text), $${params.length}) > 0`); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  if (limit !== null) params.push(limit);
  const lim = limit !== null ? `LIMIT $${params.length}` : '';
  const rows = await content.query(`SELECT s.video_id, s.line, s.start_s, s.text FROM (
      SELECT ${video} AS video_id, line, min(${at}) AS start_s, string_agg(${word}, ' ' ORDER BY ${n}) AS text
      FROM (SELECT ${video}, ${n}, ${word}, ${at},
              coalesce(sum(CASE WHEN ${word} ~ '[.?!]$' THEN 1 ELSE 0 END) OVER (PARTITION BY ${video} ORDER BY ${n} ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS line
            FROM ${S.T('words')} WHERE ${video} = ANY($1)) marked
      GROUP BY ${video}, line) s ${where} ORDER BY s.video_id, s.line ${lim}`, params);
  return rows.map(row => ({ video_id: row.video_id, start_s: Number(row.start_s), text: row.text }));
}

/** The transcript segments kept under these refs in the runs database, with their start in seconds. */
async function segmentLines(runs, settings, refs, { needle = null, limit = null } = {}) {
  if (!refs.length) return [];
  const S = schema(settings);
  const ref = S.C('transcript_segments', 'ref'), ms = S.C('transcript_segments', 'start_ms'), text = S.C('transcript_segments', 'text');
  const params = [refs];
  const filters = [`${ref} = ANY($1)`];
  if (needle !== null) { params.push(needle); filters.push(`strpos(lower(${text}), $${params.length}) > 0`); }
  if (limit !== null) params.push(limit);
  const lim = limit !== null ? `LIMIT $${params.length}` : '';
  const rows = await runs.query(`SELECT ${ref} AS ref, ${ms} AS start_ms, ${text} AS text FROM ${S.T('transcript_segments')}
    WHERE ${filters.join(' AND ')} ORDER BY ${ref}, ${ms}::numeric ${lim}`, params);
  return rows.map(row => ({ ref: row.ref, start_s: Number(row.start_ms) / 1000, text: row.text }));
}

/** The transcript refs among these that have at least one segment. */
async function refsWithSegments(runs, settings, refs) {
  if (!refs.length) return new Set();
  const S = schema(settings);
  const ref = S.C('transcript_segments', 'ref');
  const rows = await runs.query(`SELECT DISTINCT ${ref} AS ref FROM ${S.T('transcript_segments')} WHERE ${ref} = ANY($1)`, [refs]);
  return new Set(rows.map(row => row.ref));
}

/** A lesson's timed transcript: its words when the video has them, else its transcript segments. */
async function transcriptOf(dbs, lesson, settings) {
  if (lesson.has_words) return (await timedLines(dbs.content, settings, [lesson.video_id])).map(({ start_s, text }) => ({ start_s, text }));
  const ref = transcriptRefOf(lesson.video_url, settings);
  return (await segmentLines(dbs.runs, settings, ref ? [ref] : [])).map(({ start_s, text }) => ({ start_s, text }));
}

/** A lesson's passages: its transcript when the video carries one, else the passages of its collection. */
async function passagesOf(content, lesson, settings) {
  if ((lesson.transcript ?? '').trim()) return [{ id: null, text: lesson.transcript }];
  if (!lesson.collection) return [];
  const S = schema(settings);
  const rows = await content.query(`SELECT ${S.C('passages', 'id')} AS id, ${S.C('passages', 'body')} AS body FROM ${S.T('passages')}
    WHERE ${S.C('passages', 'collection')} = $1 ORDER BY ${S.C('passages', 'id')}`, [lesson.collection]);
  return rows.map(row => ({ id: row.id, text: row.body }));
}

const hasTranscript = (lesson, withSegments, settings) => Boolean((lesson.transcript ?? '').trim()) || lesson.has_words
  || withSegments.has(transcriptRefOf(lesson.video_url, settings));

const wordCount = text => String(text ?? '').split(/\s+/).filter(Boolean).length;

/** The items, in order, while their words fit the budget; the first item that does not fit ends the list. */
const withinWords = (items, textOf, budget) => {
  const kept = [];
  let words = 0;
  for (const item of items) {
    const count = wordCount(textOf(item));
    if (words + count > budget) return { kept, words, truncated: true };
    kept.push(item);
    words += count;
  }
  return { kept, words, truncated: false };
};

/** The words around the first place the search text is found, with the rest cut away. */
const snippetOf = (text, needle) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(needle);
  if (at < 0) return flat.slice(0, 160);
  const from = Math.max(0, at - 60);
  const to = Math.min(flat.length, at + needle.length + 60);
  return `${from > 0 ? '...' : ''}${flat.slice(from, to)}${to < flat.length ? '...' : ''}`;
};

/** The lessons the learner holds, each course with its video link and whether a transcript exists. */
export async function listTheLessonsIHold(input, dbs, settings) {
  const { held } = await admit(input, dbs, settings);
  const courses = await openCourses(dbs.content, held, settings);
  const lessons = courses.flatMap(course => course.lessons);
  const withSegments = await refsWithSegments(dbs.runs, settings, lessons.map(lesson => transcriptRefOf(lesson.video_url, settings)).filter(Boolean));
  return {
    courses: courses.map(course => ({
      course_id: course.id,
      title: course.title,
      lessons: course.lessons.map(lesson => ({
        lesson_id: lesson.id,
        title: lesson.title,
        video_link: lesson.video_url,
        has_transcript: hasTranscript(lesson, withSegments, settings),
      })),
    })),
  };
}

/** One lesson the learner holds: its title, video link, passages and timed transcript, within the most_words cap. */
export async function readALessonIHold(input, dbs, settings) {
  const { held } = await admit(input, dbs, settings);
  if (typeof input.lesson_id !== 'string' || input.lesson_id === '') refuse('Say which lesson to read.');
  const courses = await openCourses(dbs.content, held, settings);
  const found = courses.flatMap(course => course.lessons.map(lesson => ({ course, lesson }))).find(item => item.lesson.id === input.lesson_id);
  if (!found) refuse('That lesson is not in your courses.');
  const { course, lesson } = found;
  const passageCut = withinWords(await passagesOf(dbs.content, lesson, settings), passage => passage.text, settings.most_words);
  const lineCut = withinWords(await transcriptOf(dbs, lesson, settings), line => line.text, settings.most_words - passageCut.words);
  return {
    lesson_id: lesson.id,
    course_id: course.id,
    course: course.title,
    title: lesson.title,
    video_link: lesson.video_url,
    passages: passageCut.kept,
    transcript: lineCut.kept,
    truncated: passageCut.truncated || lineCut.truncated,
  };
}

/** Passages of the held lessons' collections that contain the search text. */
async function passageMatches(content, lessons, settings, needle, cap) {
  const collections = [...new Set(lessons.map(lesson => lesson.collection).filter(Boolean))];
  if (!collections.length) return [];
  const S = schema(settings);
  const collection = S.C('passages', 'collection'), body = S.C('passages', 'body');
  const rows = await content.query(`SELECT ${collection} AS collection, ${body} AS body FROM ${S.T('passages')}
    WHERE ${collection} = ANY($1) AND strpos(lower(${body}), $2) > 0 ORDER BY ${S.C('passages', 'id')} LIMIT $3`, [collections, needle, cap]);
  return rows.flatMap(row => lessons.filter(lesson => lesson.collection === row.collection)
    .map(lesson => ({ kind: 'passage', lesson_id: lesson.id, snippet: snippetOf(row.body, needle) })));
}

/** Timed lines of the held lessons that contain the search text: from their words, and from their segments where they have no words. */
async function lineMatches(dbs, lessons, settings, needle, cap) {
  const withWords = lessons.filter(lesson => lesson.has_words);
  const lines = await timedLines(dbs.content, settings, [...new Set(withWords.map(lesson => lesson.video_id))], { needle, limit: cap });
  const fromWords = lines.flatMap(line => withWords.filter(lesson => lesson.video_id === line.video_id)
    .map(lesson => ({ kind: 'transcript', lesson_id: lesson.id, start_s: line.start_s, snippet: snippetOf(line.text, needle) })));
  const silent = lessons.filter(lesson => !lesson.has_words && transcriptRefOf(lesson.video_url, settings));
  const segments = await segmentLines(dbs.runs, settings, silent.map(lesson => transcriptRefOf(lesson.video_url, settings)), { needle, limit: cap });
  const fromSegments = segments.flatMap(segment => silent.filter(lesson => transcriptRefOf(lesson.video_url, settings) === segment.ref)
    .map(lesson => ({ kind: 'transcript', lesson_id: lesson.id, start_s: segment.start_s, snippet: snippetOf(segment.text, needle) })));
  return [...fromWords, ...fromSegments];
}

/** Published articles that contain the search text. */
async function articleMatches(content, settings, needle, cap) {
  const S = schema(settings);
  const a = field => S.C('articles', field);
  const rows = await content.query(`SELECT ${a('path')} AS path, ${a('title')} AS title, ${a('body')} AS body FROM ${S.T('articles')}
    WHERE ${a('published')} IS NOT NULL AND ${a('published')} <= now()
      AND strpos(lower(coalesce(${a('title')}, '') || ' ' || coalesce(${a('body')}, '')), $1) > 0
    ORDER BY ${a('published')} DESC LIMIT $2`, [needle, cap]);
  return rows.map(row => ({ kind: 'article', path: row.path, title: row.title, snippet: snippetOf(`${row.title ?? ''}. ${row.body ?? ''}`, needle) }));
}

/** Text search over the held lessons (titles, passages, timed transcripts) and the published articles. */
export async function searchWhatMyCoachTeaches(input, dbs, settings) {
  const { held } = await admit(input, dbs, settings);
  const needle = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
  if (!needle) refuse('Say what to search for.');
  if (needle.length > 200) refuse('A search is at most 200 characters.');
  const cap = settings.most_matches.cap;
  const most = input.most ?? settings.most_matches.default;
  if (!Number.isInteger(most) || most < 1 || most > cap) refuse(`most must be a whole number from 1 to ${cap}.`);
  const courses = await openCourses(dbs.content, held, settings);
  const lessons = courses.flatMap(course => course.lessons.map(lesson => ({ ...lesson, course_id: course.id })));
  const matches = [
    ...lessons.filter(lesson => (lesson.title ?? '').toLowerCase().includes(needle)).map(lesson => ({ kind: 'lesson-title', lesson_id: lesson.id, snippet: lesson.title })),
    ...await passageMatches(dbs.content, lessons, settings, needle, cap),
    ...await lineMatches(dbs, lessons, settings, needle, cap),
    ...await articleMatches(dbs.content, settings, needle, cap),
  ];
  return { query: input.query.trim(), matches: matches.slice(0, most), truncated: matches.length > most };
}

const OPERATIONS = { listTheLessonsIHold, readALessonIHold, searchWhatMyCoachTeaches };

/**
 * Answers one operation. `dbs` maps each held connection's name (sign_ins, runs, content) to { query(text, params) → rows };
 * every read of the operation runs inside a read-only transaction on each of them.
 */
export async function answer(operation, input, dbs, settings) {
  if (!Object.hasOwn(OPERATIONS, operation)) throw new Error(`there is no operation ${operation}`);
  const names = Object.keys(dbs);
  for (const name of names) await dbs[name].query('BEGIN READ ONLY');
  try {
    const result = await OPERATIONS[operation](input ?? {}, dbs, settings);
    for (const name of names) await dbs[name].query('COMMIT');
    return result;
  } catch (error) {
    for (const name of names) await dbs[name].query('ROLLBACK').catch(() => {});
    throw error;
  }
}
