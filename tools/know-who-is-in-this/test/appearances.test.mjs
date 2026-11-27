// read-data/appearances.mjs and the two tools over it: every row is made-up, no person's voice, face or recording is real.
// A named stretch links its person, recording, seconds and place; an unsure or unknown voice keeps its label; a face nobody
// enrolled is not kept; keeping the same answer twice is the same rows; a later answer supersedes, never deletes; a print taken
// out refuses the keep; and the person's rows are read back by person, by recording and by words.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { keepWhoAppeared } from '../do-work/keep-who-appeared.mjs';
import { ROW_PREFIX, ROW_TYPE, faceStretches, recordingKey } from '../read-data/appearances.mjs';

const recording = `1f:${'ab'.repeat(32)}`;
const prints = () => [
  { id: 'voice-print:ann', type: 'voice-print', value: { person: 'ann', name: 'Ann Sample', samples: [[1, 0]], consent: [{ kind: 'voice', said: 'Agreed aloud', at: '2026-10-01T00:00:00Z' }] } },
  { id: 'face-print:ann', type: 'face-print', value: { person: 'ann', name: 'Ann Sample', samples: [[1, 0]], consent: [{ kind: 'face', said: 'Agreed in writing', at: '2026-10-01T00:00:00Z' }] } },
  { id: 'voice-print:bo', type: 'voice-print', value: { person: 'bo', name: 'Bo Sample', samples: [[0, 1]], consent: [{ kind: 'voice', said: 'Agreed aloud', at: '2026-10-01T00:00:00Z' }] } },
];
const heard = [
  { start: 0, end: 12.5, who: 'Ann Sample', person: 'ann', me: false, voice: 'ann', score: 0.91, text: 'Welcome to the made-up call.' },
  { start: 13, end: 20, who: 'Unsure (Ann Sample or Bo Sample?)', person: null, me: false, voice: 'voice-1', score: 0.6, unsure: ['Ann Sample', 'Bo Sample'], text: 'Maybe either of them.' },
  { start: 21, end: 30, who: 'Someone (voice-2)', person: null, me: false, voice: 'voice-2', score: 0.2, text: 'A third voice.' },
];
const seen = [
  { at: 0, box: [10, 10, 60, 70], found: 0.9, who: { id: 'ann', name: 'Ann Sample', me: false }, score: 0.8, unsure: [] },
  { at: 2, box: [12, 10, 62, 70], found: 0.9, who: { id: 'ann', name: 'Ann Sample', me: false }, score: 0.7, unsure: [] },
  { at: 4, box: [12, 10, 62, 70], found: 0.9, who: { id: 'ann', name: 'Ann Sample', me: false }, score: 0.75, unsure: [] },
  { at: 10, box: [1, 1, 9, 9], found: 0.8, who: { id: 'ann', name: 'Ann Sample', me: false }, score: 0.8, unsure: [] },
  { at: 12, box: [1, 1, 9, 9], found: 0.8, who: null, score: 0.1, unsure: [] },
];
const input = { recording, recording_name: 'sample-call.mp4', heard, seen, every_seconds: 2, people: { ann: 'friends/ann-row' }, place: { name: 'Sample room', row: 'places/sample-room' }, recorded_on: '2026-11-01' };
const consents = (list = prints()) => list.map(record => ({ how: record.type === 'voice-print' ? 'voice' : 'face', person: record.value.person, consent: record.value.consent }));
const run = (more = {}) => keepWhoAppeared({ ...input, consents: consents(), ...more }, { now: () => new Date('2026-11-13T12:00:00Z') });
// What the caller keeps from an answer: its rows as the person's appearance records, the superseded ones merged over theirs.
const keep = (store, answer) => {
  for (const row of answer.rows) store.set(`${ROW_PREFIX}${row.id}`, { id: `${ROW_PREFIX}${row.id}`, type: ROW_TYPE, value: row.values });
  for (const row of answer.superseded_rows) { const id = `${ROW_PREFIX}${row.id}`; store.set(id, { id, type: ROW_TYPE, value: { ...store.get(id).value, ...row.values } }); }
  return store;
};
const earlierOf = store => [...store.values()];

test('a stretch is a row linked to its person, recording, seconds and place; unsure and unknown voices keep their label; an unenrolled face is not kept', () => {
  const answer = run();
  assert.deepEqual([answer.named, answer.possible, answer.unknown, answer.superseded], [3, 1, 1, 0]);
  assert.equal(answer.list_id, 'appearances');
  assert.equal(answer.list.id, 'appearances');
  const rows = answer.rows.map(row => row.values);
  const named = rows.find(row => row.how === 'voice' && row.status === 'named');
  assert.equal(named.person, 'ann');
  assert.equal(named.person_row, 'friends/ann-row');
  assert.equal(named.recording, recording);
  assert.equal(named.place_name, 'Sample room');
  assert.equal(named.place, 'places/sample-room');
  assert.deepEqual([named.start, named.end], [0, 12.5]);
  assert.equal(named.appearance, 'Ann Sample heard in sample-call.mp4 from 0:00 to 0:12');
  assert.equal(named.words, 'Welcome to the made-up call.');
  const possible = rows.find(row => row.status === 'possible' && row.how === 'voice');
  assert.deepEqual([possible.could_be, possible.heard_as, possible.person], ['Ann Sample, Bo Sample', 'voice-1', undefined]);
  assert.equal(rows.find(row => row.status === 'unknown').heard_as, 'voice-2');
  const faces = rows.filter(row => row.how === 'face');
  assert.deepEqual(faces.map(row => [row.start, row.end, row.person]), [[0, 6, 'ann'], [10, 12, 'ann']]);
  assert.equal(faces[0].score, 0.7);
  assert.equal(faces[0].appearance, 'Ann Sample seen in sample-call.mp4 from 0:00 to 0:06');
  assert.doesNotMatch(JSON.stringify(rows), /samples|"mean"/);
  assert.deepEqual(answer.row_ids, answer.rows.map(row => `appearances/${row.id}`));
});

test('keeping the same answer again is the same rows; a changed answer supersedes the rows it replaces and deletes none', () => {
  const store = keep(new Map(), run());
  const before = store.size;
  const again = run({ earlier: earlierOf(store) });
  assert.equal(again.superseded, 0);
  assert.deepEqual(again.rows.map(row => row.id), [...store.keys()].map(id => id.slice(ROW_PREFIX.length)), 'the same answer is the same row ids');
  const named = heard.map((turn, at) => (at === 2 ? { ...turn, who: 'Bo Sample', person: 'bo', voice: 'bo' } : turn));
  const changed = run({ heard: named, earlier: earlierOf(store) });
  assert.equal(changed.superseded, 1);
  keep(store, changed);
  assert.equal(store.size, before + 1);
  const superseded = [...store.values()].filter(record => record.value.status === 'superseded');
  assert.deepEqual(superseded.map(record => record.value.heard_as), ['voice-2']);
  assert.equal([...store.values()].filter(record => record.value.how === 'face' && record.value.status === 'superseded').length, 0);
});

test('a print with no consent words refuses the answer; a recording with nothing heard or seen is refused', () => {
  assert.throws(() => run({ consents: consents(prints().filter(record => record.id !== 'voice-print:ann')) }), error => error.code === 'no_consent' && /no voice print with consent words for person ann/.test(error.message));
  assert.throws(() => run({ consents: consents(prints().map(record => (record.id === 'voice-print:ann' ? { ...record, value: { ...record.value, consent: [] } } : record))) }), error => error.code === 'no_consent');
  assert.throws(() => run({ consents: undefined }), error => error.code === 'no_consent');
  assert.throws(() => keepWhoAppeared({ recording }), error => error.code === 'bad_input');
  assert.throws(() => run({ people: { ann: 'not a row' } }), error => error.code === 'bad_input');
  assert.throws(() => run({ consents: 'yes' }), error => error.code === 'bad_input');
});

test('a long recording answers every row, each under its own id', () => {
  const many = Array.from({ length: 400 }, (_, at) => ({ start: at * 10, end: at * 10 + 9, who: 'Ann Sample', person: 'ann', voice: 'ann', score: 0.9, text: 'word '.repeat(40) }));
  const answer = run({ heard: many, seen: undefined });
  assert.equal(answer.rows.length, 400);
  assert.equal(new Set(answer.rows.map(row => row.id)).size, 400);
});

test('the row declares no records door and asks for the consent words and earlier rows in the request', () => {
  const row = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records.map(record => record.payload).find(payload => payload.id === 'tool:keep-who-appeared');
  assert.equal(row.invoke.records, undefined);
  assert.ok(row.input_schema.properties.consents && row.input_schema.properties.earlier);
  assert.ok(row.output_schema.required.includes('rows'));
});

test('faces nobody could be are dropped, sightings join across one and a half spacings, and an id never changes with the order of input', () => {
  const stretches = faceStretches([{ at: 6, who: { id: 'ann', name: 'A' }, score: 0.5 }, { at: 0, who: { id: 'ann', name: 'A' }, score: 0.9 }, { at: 10, who: { id: 'ann', name: 'A' }, score: 0.8 }, { at: 2, who: null, unsure: [] }], 2);
  assert.deepEqual(stretches.map(stretch => [stretch.start, stretch.end]), [[0, 2], [6, 8], [10, 12]]);
  assert.equal(recordingKey(recording), 'ab'.repeat(32));
  assert.equal(recordingKey('Sample call.mp4'), 'sample-call-mp4');
});

