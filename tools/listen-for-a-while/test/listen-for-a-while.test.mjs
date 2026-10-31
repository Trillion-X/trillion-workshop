// The listening loop on made-up pieces: a fake recorder, hearing and naming, and a fake records door. Checks that rows are
// written piece by piece as they finish (not at the end), that a piece is deleted once heard, that an empty piece writes
// nothing, that the end time and piece length are checked, that the recorder is asked for exactly the time left, and that a
// recorder that stops early is an error but one that reaches the end time is not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { endOf, finishMs, heardRows, listenForAWhile, pieceOf, pieceSeconds, recordPieces, recorderArgv, secondsLeft } from '../read-data/listen-for-a-while.mjs';

const fakeDoor = (prints = [], sessions = []) => {
  const writes = [];
  return { writes, async *list({ type }) { yield* (type === 'voice-print' ? prints : sessions); }, async write(records, { key }) { writes.push({ records, key }); return { changed: records.length }; } };
};
const turn = (start, end, who, text, extra = {}) => ({ start, end, who, me: false, voice: 'voice-1', score: 0.8, text, ...extra });

test('end time and piece length are checked', () => {
  assert.equal(endOf(1000), 1000);
  assert.equal(endOf('2026-10-31T12:00:00Z'), Date.parse('2026-10-31T12:00:00Z'));
  assert.throws(() => endOf(undefined), /until/);
  assert.throws(() => endOf('soon'), /until/);
  assert.equal(pieceSeconds(undefined), 30);
  assert.throws(() => pieceSeconds(2), /between 5 and 120/);
  assert.throws(() => pieceSeconds(500), /between 5 and 120/);
  assert.equal(secondsLeft(10_500, 10_000), 1);
  assert.equal(secondsLeft(70_000, 10_000), 60);
  assert.equal(secondsLeft(5, 10_000), 1);
});

test('the recorder opens the microphone once for exactly the time left and writes pieces back to back', () => {
  const argv = recorderArgv({ device: 'default', seconds: 30, folder: '/f', total: 110 });
  assert.deepEqual(argv.slice(argv.indexOf('-i'), argv.indexOf('-i') + 2), ['-i', ':default']);
  assert.equal(argv[argv.indexOf('-t') + 1], '110');
  assert.equal(argv[argv.indexOf('-segment_time') + 1], '30');
  assert.equal(argv.filter(x => x === '-i').length, 1);
  assert.deepEqual(pieceOf('0.wav,0.000000,30.000000\n', '/f', 1_000_000), { file: '/f/0.wav', startMs: 1_000_000, endMs: 1_030_000 });
  assert.equal(pieceOf('garbage', '/f', 0), null);
});

test('rows: one per turn, id from the listening and start, empty text dropped, unsure kept', () => {
  const rows = heardRows([turn(1, 3, 'Ann', 'Hello', { me: true, voice: 'ann' }), turn(4, 5, 'Someone (voice-2)', '  '), turn(6, 8, 'Unsure (A or B?)', 'Maybe', { unsure: ['A', 'B'], score: null })],
    { listening: 'l1', device: 'd', startMs: 1_000_000 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'heard:l1:1001000');
  assert.deepEqual(rows[0].value, { listening: 'l1', device: 'd', start: new Date(1_001_000).toISOString(), end: new Date(1_003_000).toISOString(), text: 'Hello', speaker: 'Ann', me: true, voice: 'ann', score: 0.8 });
  assert.deepEqual(rows[1].value.unsure, ['A', 'B']);
  assert.equal(rows[1].value.score, undefined, "a score never measured is left off, not null");
});

test('rows are written piece by piece as pieces finish, pieces are deleted, an empty piece writes nothing', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'listen-'));
  const files = [0, 1, 2].map(n => join(folder, `${n}.wav`));
  files.forEach(file => writeFileSync(file, 'x'));
  const door = fakeDoor();
  const seen = [];
  async function* record() {
    for (const [n, file] of files.entries()) {
      // when the next piece arrives, the previous piece's rows are already written
      seen.push(door.writes.length);
      yield { file, startMs: 1_000_000 + n * 30_000, endMs: 1_030_000 + n * 30_000 };
    }
  }
  const heard = file => (file.endsWith('1.wav') ? [] : [{ start: 0, end: 2, text: 'hi' }]);
  const name = async request => ({ speakers: [turn(0, 2, 'Someone (voice-1)', request.segments[0].text)], records: [{ kind: 'listening-voices', id: 'listening-voices:l1', listening: 'l1', unknown: [], made: 0 }] });
  const tally = await listenForAWhile({ until: 2_000_000, listening: 'l1', device: 'd', model_path: 'm' }, { door }, { record, hear: async file => heard(file), name });
  assert.deepEqual(seen, [0, 1, 1], 'piece 1 was written before piece 2 arrived; the empty piece wrote nothing');
  assert.equal(door.writes.length, 2);
  assert.equal(door.writes[0].key, 'listen:l1:1000000');
  assert.deepEqual(door.writes[0].records.map(r => r.type), ['heard', 'listening-voices']);
  assert.deepEqual(tally, { listening: 'l1', pieces: 3, turns: 2, rows_written: 2, left_out: 0 });
  assert.ok(files.every(file => !existsSync(file)), 'every piece is deleted once heard');
});

test('a listening carries its listening-voices from an earlier run into naming', async () => {
  const door = fakeDoor([], [{ id: 'listening-voices:l1', type: 'listening-voices', value: { listening: 'l1', unknown: [{ id: 'voice-1' }], made: 1 } }, { id: 'listening-voices:other', type: 'listening-voices', value: { listening: 'other', unknown: [], made: 0 } }]);
  let given;
  async function* record() { yield { file: '/nowhere.wav', startMs: 0, endMs: 1 }; }
  await listenForAWhile({ until: 1, listening: 'l1', model_path: 'm' }, { door }, { record, hear: async () => [{ start: 0, end: 1, text: 'x' }], name: async request => { given = request.voice_sessions; return { speakers: [], records: [] }; } });
  assert.deepEqual(given.map(s => s.listening), ['l1']);
});

test('a model path is required when the real hearing is used', async () => {
  await assert.rejects(listenForAWhile({ until: 1 }, { door: fakeDoor() }, { record: async function* () {} }), /model_path/);
});

function fakeRecorder(lines, code) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  setTimeout(() => { lines.forEach(line => child.stdout.write(line)); setTimeout(() => child.emit('close', code), 5); }, 5);
  return child;
}

test('the recorder yields pieces as lines arrive, tolerates a line split across chunks, and ends at the end time', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'listen-'));
  const child = fakeRecorder(['0.wav,0.0,30.0\n1.wa', 'v,30.0,60.0\n'], 0);
  const pieces = [];
  for await (const piece of recordPieces({ device: 'default', seconds: 30, folder, end: 100_000, now: () => 10_000, start: () => child })) pieces.push(piece);
  assert.deepEqual(pieces.map(p => [p.startMs, p.endMs]), [[10_000, 40_000], [40_000, 70_000]]);
});

test('a recorder that stops before the end time is an error; one stopped at the end time is not', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'listen-'));
  await assert.rejects(async () => { for await (const _ of recordPieces({ device: 'default', seconds: 30, folder, end: 100_000, now: () => 10_000, start: () => fakeRecorder([], 1) })); }, /stopped before the end time/);
  let clock = 10_000;
  const child = fakeRecorder(['0.wav,0.0,30.0\n'], 0);
  child.once('close', () => { clock = 99_000; });
  for await (const _ of recordPieces({ device: 'default', seconds: 30, folder, end: 100_000, now: () => clock, start: () => child }));
});

test('recording ends finish_seconds before until, so the run returns before the engine ends it', async () => {
  const asked = [];
  const record = async function* ({ end }) { asked.push(end); };
  await listenForAWhile({ until: 1_000_000, model_path: 'm' }, { door: fakeDoor() }, { record });
  await listenForAWhile({ until: 1_000_000, model_path: 'm', finish_seconds: 0 }, { door: fakeDoor() }, { record });
  await listenForAWhile({ until: 1_000_000, model_path: 'm', finish_seconds: 120 }, { door: fakeDoor() }, { record });
  assert.deepEqual(asked, [940_000, 1_000_000, 880_000]);
  assert.throws(() => finishMs(-1), /between 0 and 600/);
  assert.throws(() => finishMs(601), /between 0 and 600/);
});
