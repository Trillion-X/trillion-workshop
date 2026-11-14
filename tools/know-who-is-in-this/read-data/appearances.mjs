// tools/know-who-is-in-this/read-data/appearances.mjs
//
// Purpose: turn what `tool:who-is-in-this` (speakers) and `tool:find-faces` (faces) answered about one recording into the
// rows of the person's appearances list: one row per stretch of the recording in which a voice was heard or a face seen,
// linked to the person it names, the recording, the seconds and the place it was recorded. The list, its fields, its
// words and its statuses are DATA (appearances.json); nothing here names a person, a place or a recording.
//
// Non-Negotiable Invariants:
//   1. A row never holds a print's numbers: a person's id, name, a similarity score, the seconds and the words said.
//   2. A person is named only when the answer named them. A turn the answer could not name keeps its label (an unsure
//      stretch the people it could be, an unknown voice its number) so a later enrolment can name what was kept; a face
//      nobody enrolled is not kept, because nothing about it could ever be joined to anyone.
//   3. A row's id is made from the recording, how it was known, when it starts and who it is, so keeping the same answer
//      again is the same row, and an answer changed by a later enrolment is a new row beside the one it supersedes.
import data from './appearances.json' with { type: 'json' };

export const LIST = data.list;
export const ROW_TYPE = `record:${LIST.row_type}`;
export const ROW_PREFIX = `${ROW_TYPE}:`;
export const PRINT_KINDS = data.print_kinds;
export const STATUS = data.status;
export const HOW = data.how;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const refuse = words => { throw Object.assign(new Error(words), { code: 'bad_input' }); };
const fill = (line, values) => line.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
const slug = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/** The recording's part of every row id: its content identity without the prefix, else a slug of what it is called. */
export function recordingKey(recording) {
  const identity = /^1f:([0-9a-f]{64})$/.exec(recording);
  return identity ? identity[1] : slug(recording);
}

const reference = (value, what) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !/^[^/\s]+\/\S+$/.test(value)) refuse(`${what} is a row of one of the person's lists, written list-id/row-id.`);
  return value;
};

function head(input) {
  if (!object(input)) refuse('Give the recording and what was heard or seen in it.');
  const { recording, recording_name: name, heard, seen, place, people, recorded_on: recordedOn, listening, every_seconds: every } = input;
  if (typeof recording !== 'string' || !recording.trim()) refuse('Give the recording, by its identity in the person\'s files.');
  if (heard !== undefined && !Array.isArray(heard)) refuse('heard is the speakers tool\'s answer, a list of turns.');
  if (seen !== undefined && !Array.isArray(seen)) refuse('seen is the faces tool\'s answer, a list of faces.');
  if (!heard && !seen) refuse('Give heard (the answer of tool:who-is-in-this), seen (the answer of tool:find-faces) or both.');
  if (every !== undefined && !(finite(every) && every > 0)) refuse('every_seconds is the spacing find-faces used, above zero.');
  if (people !== undefined && !(object(people) && Object.values(people).every(row => typeof row === 'string'))) refuse('people maps a person id to that person\'s own row, list-id/row-id.');
  if (place !== undefined && !(object(place) && (typeof place.name === 'string' || typeof place.row === 'string'))) refuse('place is { name?, row? }: where the recording was made.');
  return {
    recording: recording.trim(), name: typeof name === 'string' && name.trim() ? name.trim() : recording.trim(), heard, seen, every,
    people: people ?? {}, place: place ?? {}, recordedOn, listening: typeof listening === 'string' ? listening : undefined,
  };
}

function unsureLabel(names) {
  const words = data.words;
  const listed = names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} ${words.or} ${names[names.length - 1]}`;
  return words.unsure.replace('{names}', listed);
}

// One person's face sightings joined into stretches: sightings no further apart than one and a half spacings are one stretch.
export function faceStretches(faces, every) {
  const stretches = [];
  const named = faces.filter(face => object(face) && finite(face.at)).sort((a, b) => a.at - b.at);
  for (const face of named) {
    const key = face.who ? `named:${face.who.id}` : `possible:${(face.unsure ?? []).map(person => person.id).sort().join('+')}`;
    if (!face.who && !(face.unsure ?? []).length) continue;
    const last = stretches.findLast(stretch => stretch.key === key);
    const spacing = every ?? 0;
    if (last && face.at - last.lastAt <= spacing * 1.5) { last.lastAt = face.at; last.end = face.at + spacing; last.score = Math.min(last.score ?? face.score, face.score ?? last.score); }
    else stretches.push({ key, who: face.who ?? null, unsure: face.unsure ?? [], start: face.at, lastAt: face.at, end: face.at + spacing, score: face.score ?? null, box: face.box });
  }
  return stretches;
}

/** The rows [{ id, values }] and the prints they rely on ([[how, person id]]) for one recording's answers. */
export function appearanceRows(input, { now = new Date() } = {}) {
  const { recording, name, heard, seen, every, people, place, recordedOn, listening } = head(input);
  const key = recordingKey(recording);
  const common = {
    recording, recording_name: name, made_by: data.made_by, kept_at: now.toISOString(),
    ...(place.row ? { place: reference(place.row, 'place.row') } : {}), ...(place.name ? { place_name: place.name } : {}),
    ...(recordedOn ? { recorded_on: recordedOn } : {}), ...(listening ? { listening } : {}),
  };
  const rows = [], relies = new Map();
  const add = ({ how, who, status, subject, start, end, extra }) => {
    if (!finite(start) || !finite(end) || start < 0 || end < start) refuse('Every turn and sighting needs finite seconds, in order.');
    const identity = who ? who.id : slug(extra.heard_as ?? extra.could_be);
    const id = `${key}:${how}:${Math.round(start * 1000)}:${slug(identity)}`;
    const line = data.words[how === HOW.voice ? 'heard' : 'seen'];
    if (who) relies.set(`${how}:${who.id}`, [how, who.id]);
    rows.push({ id, values: {
      appearance: fill(line, { subject, recording: name, from: clock(start), to: clock(end) }), subject, status, how, start, end, ...common,
      ...(who ? { person: who.id, ...(people[who.id] ? { person_row: reference(people[who.id], 'people') } : {}) } : {}), ...extra,
    } });
  };
  for (const turn of heard ?? []) {
    if (!object(turn)) refuse('Each heard turn is an object from tool:who-is-in-this.');
    const base = { how: HOW.voice, subject: String(turn.who ?? ''), start: turn.start, end: turn.end };
    const words = typeof turn.text === 'string' && turn.text.trim() ? { words: turn.text.trim() } : {};
    const score = finite(turn.score) ? { score: turn.score } : {};
    if (typeof turn.person === 'string') add({ ...base, who: { id: turn.person }, status: STATUS.named, extra: { ...words, ...score } });
    else if (Array.isArray(turn.unsure) && turn.unsure.length) add({ ...base, who: null, status: STATUS.possible, extra: { ...words, ...score, could_be: turn.unsure.join(', '), ...(turn.voice ? { heard_as: turn.voice } : {}) } });
    else if (turn.voice) add({ ...base, who: null, status: STATUS.unknown, extra: { ...words, ...score, heard_as: turn.voice } });
  }
  for (const stretch of faceStretches(seen ?? [], every)) {
    const extra = { ...(finite(stretch.score) ? { score: stretch.score } : {}), ...(Array.isArray(stretch.box) ? { box: stretch.box.join(', ') } : {}) };
    if (stretch.who) add({ how: HOW.face, who: { id: stretch.who.id }, status: STATUS.named, subject: stretch.who.name, start: stretch.start, end: stretch.end, extra });
    else {
      const names = stretch.unsure.map(person => person.name);
      add({ how: HOW.face, who: null, status: STATUS.possible, subject: unsureLabel(names), start: stretch.start, end: stretch.end, extra: { ...extra, could_be: names.join(', ') } });
    }
  }
  return { rows, relies: [...relies.values()], kinds: [...(heard ? [HOW.voice] : []), ...(seen ? [HOW.face] : [])], recording };
}

/** A person's consent words for a kind, from their print's value; none when there is no print or no words. */
export const consentOf = value => (object(value) && Array.isArray(value.consent) ? value.consent.filter(item => (typeof item === 'string' ? item.trim() : String(item?.said ?? '').trim())) : []);
