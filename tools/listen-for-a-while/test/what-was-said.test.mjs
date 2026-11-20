// What is done with heard turns once they are handed in, with no records door at all: a voice named once it is
// enrolled, captions (F-0792), the transcriber role (F-0793) and the transcript cursor (F-0297). Every tool answers
// from its request and keeps nothing: the answer holds the result, and what the caller hands in is never changed.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenForAWhile } from '../read-data/listen-for-a-while.mjs';
import { applyCaptions, askWhatWasSaid, captionWhatIsHeard, mayTranscribe, nameHeardVoice, reduceCaptions, renamedRows, roleHolder, turnsAfter } from '../read-data/what-was-said.mjs';

const noDoor = { get door() { throw new Error('this tool is handed no records door'); } };
const heard = (listening, ms, value) => ({ id: `heard:${listening}:${ms}`, type: 'heard', value: { listening, device: 'd', start: new Date(ms).toISOString(), end: new Date(ms + 2000).toISOString(), me: false, ...value } });
const pieceIn = (folder, name = '0.wav') => { const file = join(folder, name); writeFileSync(file, 'sound'); return file; };
const named = text => async () => ({ speakers: [{ start: 1, end: 3, who: 'Someone (voice-1)', me: false, voice: 'voice-1', score: 0.8, text }], records: [] });

test('a voice heard before it was enrolled is renamed in its listening only, and only where it is still unknown; the answer holds the renamed turns', () => {
  const rows = [
    heard('l1', 1000, { speaker: 'Someone (voice-2)', voice: 'voice-2', text: 'one' }),
    heard('l1', 5000, { speaker: 'Someone (voice-5)', voice: 'voice-5', text: 'two' }),
    heard('l1', 9000, { speaker: 'Dana Example', voice: 'voice-2', text: 'named already' }),
    heard('l1', 12000, { speaker: 'Someone (voice-3)', voice: 'voice-3', text: 'someone else' }),
    heard('l2', 1000, { speaker: 'Someone (voice-2)', voice: 'voice-2', text: 'another listening' }),
  ];
  const before = JSON.stringify(rows);
  const done = nameHeardVoice({ listening: 'l1', voices: ['voice-2', 'voice-5'], name: 'Sam Example', heard: rows });
  assert.equal(done.renamed, 2);
  assert.deepEqual(done.rows.map(row => [row.id, row.value.speaker, row.value.renamed_from]), [['heard:l1:1000', 'Sam Example', 'Someone (voice-2)'], ['heard:l1:5000', 'Sam Example', 'Someone (voice-5)']],
    'a turn a person already named, another voice and another listening are never changed');
  assert.equal(JSON.stringify(rows), before, 'the rows handed in are left as they were');
  assert.deepEqual(renamedRows([heard('l1', 1, { speaker: 'Unsure (A or B?)', voice: 'voice-2' })], { voices: ['voice-2'], name: 'A' }), []);
  assert.throws(() => nameHeardVoice({ listening: 'l1', name: 'x', heard: rows }), /voices/);
});

test('F-0792: caption ops keep the person\'s corrections beside the words, applied when read; the answer holds the new state', () => {
  const rows = [heard('l1', 1000, { speaker: 'Someone (voice-1)', text: 'helo' }), heard('l1', 4000, { speaker: 'Dana Example', text: 'noise' })];
  let state = reduceCaptions(undefined, { op: 'edit', id: 'heard:l1:1000', text: 'hello' });
  state = reduceCaptions(state, { op: 'speaker', id: 'heard:l1:1000', name: 'Sam Example' });
  state = reduceCaptions(state, { op: 'hide', id: 'heard:l1:4000' });
  const lines = applyCaptions(rows, state);
  assert.deepEqual(lines.map(line => [line.speaker, line.text]), [['Sam Example', 'hello']]);
  assert.deepEqual(lines[0].heard_as, { text: 'helo', speaker: 'Someone (voice-1)' });
  assert.equal(applyCaptions(rows, reduceCaptions(state, { op: 'show', id: 'heard:l1:4000' })).length, 2);
  assert.equal(applyCaptions(rows, reduceCaptions(state, { op: 'undo', id: 'heard:l1:1000' }))[0].text, 'helo');
  assert.equal(reduceCaptions(state, { op: 'off' }).on, false);
  assert.throws(() => reduceCaptions(state, { op: 'shout' }), /not a caption op/);
  assert.throws(() => reduceCaptions(state, { op: 'edit', text: 'x' }), /needs `id`/);

  const shown = captionWhatIsHeard({ listening: 'l1', heard: rows, ops: [{ op: 'edit', id: 'heard:l1:1000', text: 'hello' }] });
  assert.deepEqual(shown.lines.map(line => line.text), ['hello', 'noise']);
  assert.equal(rows[0].value.text, 'helo', 'a heard row is never rewritten by a caption');
  assert.equal(shown.captions.edits['heard:l1:1000'].text, 'hello', 'the answer holds the captions state to hand in next time');
  const next = captionWhatIsHeard({ listening: 'l1', heard: rows, captions: shown.captions, ops: [{ op: 'hide', id: 'heard:l1:4000' }] });
  assert.deepEqual(next.lines.map(line => line.text), ['hello']);
  const off = captionWhatIsHeard({ listening: 'l1', heard: rows, captions: next.captions, ops: [{ op: 'off' }] });
  assert.deepEqual([off.on, off.lines], [false, []]);
  assert.throws(() => captionWhatIsHeard({ heard: rows }), /listening/);
});

test('F-0793: one device holds the transcriber role until its time runs out; a piece another live holder covers is let go', async () => {
  const now = Date.parse('2026-11-04T10:00:00Z');
  const held = { device: 'laptop', until: new Date(now + 180_000).toISOString() };
  assert.equal(roleHolder(held, now + 1000), 'laptop');
  assert.equal(roleHolder(held, now + 181_000), null, 'a role run out is free');
  assert.ok(mayTranscribe(held, 'laptop', now) && !mayTranscribe(held, 'phone', now) && mayTranscribe(null, 'phone', now));

  const folder = tempFolder(join(tmpdir(), 'role-'));
  async function* record() { yield { file: pieceIn(folder), startMs: now, endMs: now + 30_000 }; }
  const tally = await listenForAWhile({ until: now + 3_600_000, listening: 'l1', device: 'phone', model_path: 'm', transcriber: held }, noDoor,
    { record, now: () => now + 5000, hear: async () => { throw new Error('a piece the laptop covers is not heard here'); }, name: named('x') });
  assert.equal(tally.let_go, 1);
  assert.equal(tally.transcriber, 'laptop');
  assert.deepEqual(tally.heard, []);
  assert.equal(tally.heard_until, null, 'what the laptop covers is not heard here');

  async function* later() { yield { file: pieceIn(folder, '1.wav'), startMs: now + 200_000, endMs: now + 230_000 }; }
  const taken = await listenForAWhile({ until: now + 3_600_000, listening: 'l1', device: 'phone', model_path: 'm', transcriber: held }, noDoor,
    { record: later, now: () => now + 200_000, hear: async () => [{ start: 1, end: 2, text: 'mine now' }], name: named('mine now') });
  assert.equal(taken.heard.length, 1);
  assert.equal(taken.heard_until, new Date(now + 230_000).toISOString());
});

test('F-0297: an ask gives a conversation only the turns after its cursor, with the captions applied, and answers the next cursor', () => {
  const rows = [
    heard('l1', 1000, { speaker: 'Dana Example', text: 'first' }), heard('l1', 4000, { speaker: 'Sam Example', text: 'secnd' }),
    heard('l2', 2000, { speaker: 'Dana Example', text: 'another listening' }),
  ];
  const captions = { listening: 'l1', on: true, edits: { 'heard:l1:4000': { text: 'second' } } };
  const first = askWhatWasSaid({ listening: 'l1', heard: rows, captions });
  assert.deepEqual(first.lines.map(line => line.text), ['first', 'second']);
  assert.equal(first.cursor, 4000);
  assert.deepEqual(askWhatWasSaid({ listening: 'l1', heard: rows, captions, cursor: first.cursor }).lines, [], 'nothing is given twice');
  const more = [...rows, heard('l1', 9000, { speaker: 'Dana Example', text: 'third' })];
  const next = askWhatWasSaid({ listening: 'l1', heard: more, captions, cursor: first.cursor });
  assert.deepEqual(next.lines.map(line => line.text), ['third']);
  assert.equal(next.cursor, 9000);
  assert.equal(askWhatWasSaid({ listening: 'l1', heard: more, captions }).lines.length, 3, 'a conversation with no cursor is given everything');
  assert.deepEqual(turnsAfter([heard('l1', 5, {}), heard('l1', 50, {})], 5).map(row => row.id), ['heard:l1:50']);
  assert.throws(() => askWhatWasSaid({ heard: rows }), /listening/);
});
