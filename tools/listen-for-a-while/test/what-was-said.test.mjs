// What happens to heard rows after they are written, on a fake records door that keeps what is written: a voice named
// once it is enrolled, a piece's sound kept with each turn's place, who spoke written beside a recording, captions
// (F-0792), the transcriber role (F-0793), the transcript cursor (F-0297) and the ask-time flush (F-0298).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hearForADevice, listenForAWhile } from '../read-data/listen-for-a-while.mjs';
import { applyCaptions, askWhatWasSaid, captionWhatIsHeard, encodePiece, mayTranscribe, nameHeardVoice, reduceCaptions, renamedRows, roleHolder, roleRow,
  soundNameOf, speakersOf, statusRow, turnsAfter, waitForHearing } from '../read-data/what-was-said.mjs';

/** A door that keeps every record written ({ id, type, value }), lists by type and id prefix, and keeps files. */
const keepingDoor = (records = [], files = {}) => {
  const kept = new Map(records.map(row => [row.id, row]));
  const writes = [];
  const uploads = {};
  const written = {};
  return {
    kept, writes, written,
    async *list({ type, prefix = '' }) { yield* [...kept.values()].filter(row => row.type === type && row.id.startsWith(prefix)); },
    async read(type, id) { const row = kept.get(id); return row?.type === type ? row.value : null; },
    async write(rows, { key }) { writes.push({ rows, key }); for (const row of rows) kept.set(row.id, row); return { changed: rows.length }; },
    async files(method, input) {
      if (method === 'find_file') return { names: [input.name_or_identity] };
      if (method === 'read_file') {
        const bytes = Buffer.from(files[input.name_or_identity]);
        const piece = bytes.subarray(input.offset, input.offset + input.length);
        return { byte_length: bytes.length, bytes_returned: piece.length, encoding: 'base64', content: piece.toString('base64') };
      }
      if (method === 'write_file_start') { uploads[input.upload_id] = []; return { next_offset: 0 }; }
      if (method === 'write_file_piece') { uploads[input.upload_id].push(Buffer.from(input.content_base64, 'base64')); return {}; }
      if (method === 'write_file_finish') { written[input.name] = Buffer.concat(uploads[input.upload_id]); return { name: input.name }; }
      throw new Error(method);
    },
  };
};
const heard = (listening, ms, value) => ({ id: `heard:${listening}:${ms}`, type: 'heard', value: { listening, device: 'd', start: new Date(ms).toISOString(), end: new Date(ms + 2000).toISOString(), me: false, ...value } });
const pieceIn = (folder, name = '0.wav') => { const file = join(folder, name); writeFileSync(file, 'sound'); return file; };
const named = text => async () => ({ speakers: [{ start: 1, end: 3, who: 'Someone (voice-1)', me: false, voice: 'voice-1', score: 0.8, text }], records: [] });

test('a voice heard before it was enrolled is renamed in its listening only, and only where it is still unknown', async () => {
  const door = keepingDoor([
    heard('l1', 1000, { speaker: 'Someone (voice-2)', voice: 'voice-2', text: 'one' }),
    heard('l1', 5000, { speaker: 'Someone (voice-5)', voice: 'voice-5', text: 'two' }),
    heard('l1', 9000, { speaker: 'Dana Example', voice: 'voice-2', text: 'named already' }),
    heard('l1', 12000, { speaker: 'Someone (voice-3)', voice: 'voice-3', text: 'someone else' }),
    heard('l2', 1000, { speaker: 'Someone (voice-2)', voice: 'voice-2', text: 'another listening' }),
  ]);
  const done = await nameHeardVoice({ listening: 'l1', voices: ['voice-2', 'voice-5'], name: 'Sam Example' }, { door });
  assert.equal(done.renamed, 2);
  assert.equal(door.kept.get('heard:l1:1000').value.speaker, 'Sam Example');
  assert.equal(door.kept.get('heard:l1:1000').value.renamed_from, 'Someone (voice-2)');
  assert.equal(door.kept.get('heard:l1:5000').value.speaker, 'Sam Example');
  assert.equal(door.kept.get('heard:l1:9000').value.speaker, 'Dana Example', 'a turn a person already named is never changed');
  assert.equal(door.kept.get('heard:l1:12000').value.speaker, 'Someone (voice-3)');
  assert.equal(door.kept.get('heard:l2:1000').value.speaker, 'Someone (voice-2)', 'another listening is never changed');
  assert.deepEqual(renamedRows([heard('l1', 1, { speaker: 'Unsure (A or B?)', voice: 'voice-2' })], { voices: ['voice-2'], name: 'A' }), []);
  await assert.rejects(nameHeardVoice({ listening: 'l1', name: 'x' }, { door }), /voices/);
});

test('with keep_sound, a piece\'s sound is kept in the person\'s files and each turn says its place in it; without it, nothing is', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'keep-'));
  const door = keepingDoor();
  async function* record() { yield { file: pieceIn(folder), startMs: Date.parse('2026-11-04T10:00:00Z'), endMs: Date.parse('2026-11-04T10:00:30Z') }; }
  const tally = await listenForAWhile({ until: Date.parse('2026-11-04T11:00:00Z'), listening: 'l1', device: 'd', model_path: 'm', keep_sound: { folder: '/Listening/', keep_days: 30 } },
    { door }, { record, hear: async () => [{ start: 1, end: 3, text: 'keep me' }], name: named('keep me'), encode: async () => Buffer.from('compressed') });
  const name = '/Listening/2026-11-04/l1-10-00-00.m4a';
  assert.equal(soundNameOf({ folder: '/Listening/', listening: 'l1', startMs: Date.parse('2026-11-04T10:00:00Z') }), name);
  assert.equal(String(door.written[name]), 'compressed');
  const row = door.kept.get(`heard:l1:${Date.parse('2026-11-04T10:00:01Z')}`).value;
  assert.deepEqual([row.sound, row.sound_from, row.sound_to, row.keep_until], [name, 1, 3, '2026-12-04T10:00:00.000Z']);
  assert.equal(tally.sounds_kept, 1);
  assert.ok(tally.leaves.some(item => item.id === 'sound'), 'the leaves list says the sound is kept');

  const off = keepingDoor();
  async function* again() { yield { file: pieceIn(folder, '1.wav'), startMs: 0, endMs: 30_000 }; }
  const plain = await listenForAWhile({ until: 3_600_000, listening: 'l2', device: 'd', model_path: 'm' }, { door: off }, { record: again, hear: async () => [{ start: 1, end: 3, text: 'x' }], name: named('x'), encode: async () => { throw new Error('never'); } });
  assert.deepEqual(off.written, {});
  assert.ok(!plain.leaves.some(item => item.id === 'sound'));

  const failing = keepingDoor();
  async function* third() { yield { file: pieceIn(folder, '2.wav'), startMs: 0, endMs: 30_000 }; }
  const words = await listenForAWhile({ until: 3_600_000, listening: 'l3', device: 'd', model_path: 'm', keep_sound: { folder: '/L' } }, { door: failing },
    { record: third, hear: async () => [{ start: 1, end: 3, text: 'still written' }], name: named('still written'), encode: async () => { throw new Error('no encoder'); } });
  assert.equal(words.rows_written, 1, 'a sound that cannot be kept never stops the words');
  assert.match(words.sound_error, /no encoder/);
});

test('a piece is compressed for keeping with the real ffmpeg here', { skip: !existsSync('/usr/bin/ffmpeg') && !existsSync('/opt/homebrew/bin/ffmpeg') }, async () => {
  const ffmpeg = existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : '/opt/homebrew/bin/ffmpeg';
  const file = join(mkdtempSync(join(tmpdir(), 'encode-')), 'piece.wav');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=2', '-ac', '1', '-ar', '16000', '-y', file]);
  const bytes = await encodePiece(file, { ffmpeg });
  assert.ok(bytes.length > 500 && bytes.subarray(4, 8).toString() === 'ftyp', 'an MP4 audio file');
});

test('with write_back, who said each turn of a device\'s recording is written beside it, in seconds of the recording', async () => {
  const door = keepingDoor([], { '/Recordings/talk.wav': 'sound bytes' });
  const at = '2026-11-04T09:00:00Z';
  const tally = await hearForADevice({ file: '/Recordings/talk.wav', device: 'phone', at, model_path: 'm', write_back: true }, { door },
    { hear: async () => [{ start: 1, end: 3, text: 'hello' }], name: named('hello') });
  assert.equal(tally.written_back, '/Recordings/talk.wav.speakers.json');
  const back = JSON.parse(String(door.written['/Recordings/talk.wav.speakers.json']));
  assert.deepEqual(back.turns.map(turn => [turn.start, turn.end, turn.speaker, turn.text]), [[1, 3, 'Someone (voice-1)', 'hello']]);
  assert.equal(back.heard_at, new Date(at).toISOString());
  const none = keepingDoor([], { '/r.wav': 'x' });
  await hearForADevice({ file: '/r.wav', device: 'phone', model_path: 'm' }, { door: none }, { hear: async () => [{ start: 0, end: 1, text: 'x' }], name: named('x') });
  assert.deepEqual(none.written, {}, 'nothing is written beside a recording unless asked');
  assert.deepEqual(speakersOf([], { file: '/a', startMs: 0 }).turns, []);
});

test('F-0792: caption ops keep the person\'s corrections beside the words, applied when read; the words as heard stay', async () => {
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

  const door = keepingDoor(rows);
  const shown = await captionWhatIsHeard({ listening: 'l1', ops: [{ op: 'edit', id: 'heard:l1:1000', text: 'hello' }] }, { door });
  assert.deepEqual(shown.lines.map(line => line.text), ['hello', 'noise']);
  assert.equal(door.kept.get('heard:l1:1000').value.text, 'helo', 'a heard row is never rewritten by a caption');
  assert.equal(door.kept.get('captions:l1').value.edits['heard:l1:1000'].text, 'hello');
  assert.deepEqual((await captionWhatIsHeard({ listening: 'l1', ops: [{ op: 'off' }] }, { door })).lines, []);
});

test('F-0793: one device holds the transcriber role while its keepalive lasts; a piece another live holder covers is let go', async () => {
  const now = Date.parse('2026-11-04T10:00:00Z');
  const held = roleRow('l1', 'laptop', now).value;
  assert.equal(roleHolder(held, now + 1000), 'laptop');
  assert.equal(roleHolder(held, now + 181_000), null, 'a keepalive run out frees the role');
  assert.ok(mayTranscribe(held, 'laptop', now) && !mayTranscribe(held, 'phone', now) && mayTranscribe(null, 'phone', now));

  const folder = mkdtempSync(join(tmpdir(), 'role-'));
  const door = keepingDoor([roleRow('l1', 'laptop', now)]);
  async function* record() { yield { file: pieceIn(folder), startMs: now, endMs: now + 30_000 }; }
  const tally = await listenForAWhile({ until: now + 3_600_000, listening: 'l1', device: 'phone', model_path: 'm' }, { door },
    { record, now: () => now + 5000, hear: async () => { throw new Error('a piece the laptop covers is not heard here'); }, name: named('x') });
  assert.equal(tally.let_go, 1);
  assert.equal(tally.transcriber, 'laptop');
  assert.equal(door.kept.get('transcriber:l1').value.device, 'laptop', 'the holder\'s role is left alone');

  const free = keepingDoor([roleRow('l1', 'laptop', now)]);
  async function* later() { yield { file: pieceIn(folder, '1.wav'), startMs: now + 200_000, endMs: now + 230_000 }; }
  const taken = await listenForAWhile({ until: now + 3_600_000, listening: 'l1', device: 'phone', model_path: 'm' }, { door: free },
    { record: later, now: () => now + 200_000, hear: async () => [{ start: 1, end: 2, text: 'mine now' }], name: named('mine now') });
  assert.equal(taken.rows_written, 1);
  assert.equal(free.kept.get('transcriber:l1').value.device, 'phone', 'a run-out role is taken and kept alive by the device that hears');
});

test('F-0298: each piece says it is being heard, then how far what was said is written; an ask waits for that, or not past its limit', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'status-'));
  const door = keepingDoor();
  const pending = [];
  const watched = { ...door, async write(rows, options) { for (const row of rows) if (row.type === 'listening-status') pending.push([row.value.hearing_pending, row.value.heard_until]); return door.write(rows, options); } };
  async function* record() { yield { file: pieceIn(folder), startMs: 60_000, endMs: 90_000 }; }
  await listenForAWhile({ until: 3_600_000, listening: 'l1', device: 'd', model_path: 'm' }, { door: watched }, { record, now: () => 95_000, hear: async () => [{ start: 1, end: 2, text: 'x' }], name: named('x') });
  assert.deepEqual(pending, [[true, null], [false, new Date(90_000).toISOString()]]);

  let clock = 100_000;
  const status = keepingDoor([statusRow('l2', { pending: true, heardUntilMs: 60_000, now: clock, device: 'd' })]);
  const sleep = async ms => { clock += ms; if (clock >= 104_000) await status.write([statusRow('l2', { pending: false, heardUntilMs: 120_000, now: clock, device: 'd' })], { key: 'k' }); };
  const flushed = await waitForHearing(status, 'l2', { askedAt: 110_000, waitMs: 40_000, now: () => clock, sleep });
  assert.deepEqual([flushed.flushed, flushed.live, flushed.heard_until], [true, true, new Date(120_000).toISOString()]);
  assert.ok(flushed.waited_ms >= 4000 && flushed.waited_ms < 40_000);

  clock = 100_000;
  const stuck = keepingDoor([statusRow('l3', { pending: true, heardUntilMs: 60_000, now: clock, device: 'd' })]);
  const limited = await waitForHearing(stuck, 'l3', { askedAt: 110_000, waitMs: 10_000, now: () => clock, sleep: async ms => { clock += ms; } });
  assert.deepEqual([limited.flushed, limited.waited_ms], [false, 10_000], 'an ask never waits past its limit');
  const gone = await waitForHearing(keepingDoor(), 'nothing', { askedAt: 1, waitMs: 10_000, now: () => 0, sleep: async () => { throw new Error('not waited for'); } });
  assert.deepEqual([gone.flushed, gone.live], [false, false], 'a listening that is not live is not waited for');
});

test('F-0297: an ask gives each conversation only the turns it was not given yet, with the captions applied', async () => {
  const now = 1_000_000;
  const door = keepingDoor([
    heard('l1', 1000, { speaker: 'Dana Example', text: 'first' }), heard('l1', 4000, { speaker: 'Sam Example', text: 'secnd' }),
    { id: 'captions:l1', type: 'captions', value: { listening: 'l1', on: true, edits: { 'heard:l1:4000': { text: 'second' } } } },
    statusRow('l1', { pending: false, heardUntilMs: now, now, device: 'd' }),
  ]);
  const first = await askWhatWasSaid({ listening: 'l1', conversation: 'c1' }, { door }, { now: () => now });
  assert.deepEqual(first.lines.map(line => line.text), ['first', 'second']);
  assert.equal(first.flushed, true);
  assert.equal(door.kept.get('ask-cursor:c1:l1').value.after_ms, 4000);
  assert.deepEqual((await askWhatWasSaid({ listening: 'l1', conversation: 'c1' }, { door }, { now: () => now })).lines, [], 'nothing is given twice');
  await door.write([heard('l1', 9000, { speaker: 'Dana Example', text: 'third' })], { key: 'k' });
  assert.deepEqual((await askWhatWasSaid({ listening: 'l1', conversation: 'c1' }, { door }, { now: () => now })).lines.map(line => line.text), ['third']);
  assert.equal((await askWhatWasSaid({ listening: 'l1', conversation: 'c2' }, { door }, { now: () => now })).lines.length, 3, 'another conversation has its own cursor');
  assert.deepEqual(turnsAfter([heard('l1', 5, {}), heard('l1', 50, {})], { after_ms: 5 }).map(row => row.id), ['heard:l1:50']);
  await assert.rejects(askWhatWasSaid({ listening: 'l1' }, { door }), /conversation/);
});
