// read-data/appearances.mjs and the two tools over it: every row is made-up, no person's voice, face or recording is real.
// A named stretch links its person, recording, seconds and place; an unsure or unknown voice keeps its label; a face nobody
// enrolled is not kept; keeping the same answer twice is the same rows; a later answer supersedes, never deletes; a print taken
// out refuses the keep; and the person's rows are read back by person, by recording and by words.
import assert from 'node:assert/strict';
import test from 'node:test';
import { keepWhoAppeared } from '../do-work/keep-who-appeared.mjs';
import { whereSomeoneAppeared } from '../do-work/where-someone-appeared.mjs';
import { faceStretches, recordingKey } from '../read-data/appearances.mjs';
import { memoryDoor } from '../../watch-my-sources/test/memory-door.mjs';

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
const run = (door, more = {}) => keepWhoAppeared({ ...input, ...more }, { door, now: () => new Date('2026-11-13T12:00:00Z') });
const rowsOf = door => [...door.kept.values()].filter(record => record.type === 'record:appearance');

test('a stretch is a row linked to its person, recording, seconds and place; unsure and unknown voices keep their label; an unenrolled face is not kept', async () => {
  const door = memoryDoor(prints());
  const answer = await run(door);
  assert.deepEqual([answer.named, answer.possible, answer.unknown, answer.superseded], [3, 1, 1, 0]);
  assert.ok(door.kept.has('list:appearances'));
  const rows = rowsOf(door).map(record => record.value);
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
});

test('keeping the same answer again is the same rows; a changed answer supersedes the rows it replaces and deletes none', async () => {
  const door = memoryDoor(prints());
  await run(door);
  const before = rowsOf(door).length;
  const again = await run(door);
  assert.equal(again.superseded, 0);
  assert.equal(rowsOf(door).length, before);
  const named = heard.map((turn, at) => (at === 2 ? { ...turn, who: 'Bo Sample', person: 'bo', voice: 'bo' } : turn));
  const changed = await run(door, { heard: named });
  assert.equal(changed.superseded, 1);
  assert.equal(rowsOf(door).length, before + 1);
  const superseded = rowsOf(door).filter(record => record.value.status === 'superseded');
  assert.deepEqual(superseded.map(record => record.value.heard_as), ['voice-2']);
  assert.equal(rowsOf(door).filter(record => record.value.how === 'face' && record.value.status === 'superseded').length, 0);
});

test('a print taken out refuses the keep and writes nothing; a recording with nothing heard or seen is refused', async () => {
  const door = memoryDoor(prints().filter(record => record.id !== 'voice-print:ann'));
  await assert.rejects(() => run(door), error => error.code === 'no_consent' && /no voice print with consent words for person ann/.test(error.message));
  assert.equal(door.writes.length, 0);
  const consentless = memoryDoor(prints().map(record => (record.id === 'voice-print:ann' ? { ...record, value: { ...record.value, consent: [] } } : record)));
  await assert.rejects(() => run(consentless), error => error.code === 'no_consent');
  await assert.rejects(() => keepWhoAppeared({ recording }, { door: memoryDoor() }), error => error.code === 'bad_input');
  await assert.rejects(() => keepWhoAppeared({ ...input, people: { ann: 'not a row' } }, { door: memoryDoor(prints()) }), error => error.code === 'bad_input');
});

test('a long recording is written in batches that each fit the door, and every row lands', async () => {
  const door = memoryDoor(prints());
  const many = Array.from({ length: 400 }, (_, at) => ({ start: at * 10, end: at * 10 + 9, who: 'Ann Sample', person: 'ann', voice: 'ann', score: 0.9, text: 'word '.repeat(40) }));
  await run(door, { heard: many, seen: undefined });
  assert.equal(rowsOf(door).length, 400);
  assert.ok(door.writes.length > 2);
});

test('faces nobody could be are dropped, sightings join across one and a half spacings, and an id never changes with the order of input', () => {
  const stretches = faceStretches([{ at: 6, who: { id: 'ann', name: 'A' }, score: 0.5 }, { at: 0, who: { id: 'ann', name: 'A' }, score: 0.9 }, { at: 10, who: { id: 'ann', name: 'A' }, score: 0.8 }, { at: 2, who: null, unsure: [] }], 2);
  assert.deepEqual(stretches.map(stretch => [stretch.start, stretch.end]), [[0, 2], [6, 8], [10, 12]]);
  assert.equal(recordingKey(recording), 'ab'.repeat(32));
  assert.equal(recordingKey('Sample call.mp4'), 'sample-call-mp4');
});

test('the person\'s rows are read back by person, by recording and by words, with who and which recordings counted', async () => {
  const door = memoryDoor(prints());
  await run(door);
  await run(door, { recording: `1f:${'cd'.repeat(32)}`, recording_name: 'other.wav', seen: undefined, heard: [heard[0]] });
  door.search = async ({ question }) => ({ results: rowsOf(door).filter(record => JSON.stringify(record.value).toLowerCase().includes(question.toLowerCase())).map(record => ({ id: `record:${record.id}`, address: { input: { id: record.id, type: record.type } } })) });
  const byPerson = await whereSomeoneAppeared({ person: 'ann' }, { door });
  assert.deepEqual(byPerson.recordings.map(item => [item.label, item.appearances]), [['other.wav', 1], ['sample-call.mp4', 3]]);
  assert.deepEqual(byPerson.people, [{ id: 'ann', label: 'Ann Sample', appearances: 4 }]);
  const byRecording = await whereSomeoneAppeared({ recording, how: 'face' }, { door });
  assert.deepEqual(byRecording.appearances.map(row => row.start), [0, 10]);
  const byWords = await whereSomeoneAppeared({ words: 'sample room' }, { door });
  assert.equal(byWords.appearances.length, 6);
  await assert.rejects(() => whereSomeoneAppeared({}, { door }), error => error.code === 'bad_input');
});
