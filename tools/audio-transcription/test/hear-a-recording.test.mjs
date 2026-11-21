// tools/audio-transcription/test/hear-a-recording.test.mjs
//
// read-data/hear-here.mjs (tool:hear-a-recording): a file the engine placed in the run's folder is heard where it is; a
// recording named in the person's files is read through the run's host (host.readWholeFile),
// heard in the run's own folder and removed; the seam's transcript answers as { text, segments, language }; a request
// without a file or a model is refused before anything is read, and a file above the size the run reads is refused.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hearAndKeepARecording, hearARecording, hearFile, placedIdentity } from '../read-data/hear-here.mjs';

const hostWith = (answer, calls = []) => ({
  calls,
  async readWholeFile(name, options) { calls.push({ name, options }); return answer; },
});

test('a recording read by name through the host is heard in the run folder, and the copy is removed', async () => {
  const bytes = Buffer.from('sound bytes');
  const host = hostWith({ title: 'a-talk.m4a', size: bytes.length, bytes });
  let heardAt = null;
  const answer = await hearARecording({ file: '/Recordings/a-talk.m4a' }, host, {
    hear: async file => { heardAt = file; assert.equal(readFileSync(file, 'utf8'), 'sound bytes'); return { text: 'hi there', segments: [{ start: 0, end: 1, text: 'hi there' }], language: 'en', produced_by: 'ears' }; },
  });
  assert.deepEqual(answer, { text: 'hi there', segments: [{ start: 0, end: 1, text: 'hi there' }], language: 'en', produced_by: 'ears', heard_whole: true });
  assert.equal(host.calls[0].name, '/Recordings/a-talk.m4a');
  assert.match(heardAt, /recording\.m4a$/);
  assert.equal(existsSync(heardAt), false);
});

test('a file the engine placed in the run folder is heard where it is, and nothing is read through the door', async () => {
  const folder = tempFolder(join(tmpdir(), 'placed-'));
  const placed = join(folder, 'C8572.MP4');
  writeFileSync(placed, 'placed sound bytes');
  const host = hostWith({ title: 'x', size: 1, bytes: Buffer.from('x') });
  let heardAt = null;
  const answer = await hearARecording({ file: placed }, host, { hear: async file => { heardAt = file; return { text: 'hi', segments: [], language: 'en', produced_by: 'ears' }; } });
  assert.equal(heardAt, placed);
  assert.equal(answer.heard_whole, true);
  assert.equal(host.calls.length, 0);
  assert.equal(readFileSync(placed, 'utf8'), 'placed sound bytes', 'the placed file is left for the engine to remove');
});

test('without a file or a model nothing is read', async () => {
  const host = hostWith({ title: 'x', size: 1, bytes: Buffer.from('x') });
  await assert.rejects(hearARecording({}, host), /Give `file`/);
  await assert.rejects(hearARecording({ file: 'f' }, host), /Give model_path/);
  assert.equal(host.calls.length, 0);
});

test('a recording above the size one run reads is refused with why', async () => {
  const host = hostWith({ title: 'big.wav', size: 999, bytes: null });
  await assert.rejects(hearARecording({ file: 'big.wav' }, host, { hear: async () => ({}) }), /999 bytes, more than one run reads/);
});

test("the seam's transcript is answered as text, segments and language", async () => {
  const folder = tempFolder(join(tmpdir(), 'seam-'));
  const script = join(folder, 'seam.py');
  writeFileSync(script, `import json, sys\nargs = sys.argv\nout = args[args.index('--out') + 1]\nassert args[args.index('--whisper-cli') + 1] == '/granted/whisper-cli'\njson.dump({"segments": [{"start": 0, "end": 2, "text": " hello ", "words": []}], "full_text": "hello", "language": "en"}, open(out, "w"))\n`);
  const audio = join(folder, 'a.wav');
  writeFileSync(audio, 'x');
  const heard = await hearFile(audio, { modelPath: '/models/m.bin', whisperCli: '/granted/whisper-cli', script });
  assert.deepEqual(heard, { text: 'hello', segments: [{ start: 0, end: 2, text: 'hello' }], language: 'en', duration: null, produced_by: 'whisper-cli on this computer' });
  assert.equal(existsSync(`${audio}.heard.json`), false);
});

// The engine places a file by identity at <run folder>/<folder>/<identity hex>/<name> (trillion-rust input_files.rs).
const HEX = 'ab'.repeat(32);
const placedRecording = () => {
  const folder = join(tempFolder(join(tmpdir(), 'kept-')), 'inputs', HEX);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, 'C8572.MP4');
  writeFileSync(file, 'placed sound bytes');
  return file;
};
const heardWords = n => ({ text: 'w '.repeat(n).trim(), segments: Array.from({ length: n }, (_, i) => ({ start: i, end: i + 0.5, text: 'w' })), language: 'en', duration: n, produced_by: 'ears' });

test('a placed recording is heard, its whole transcript kept in Files, and only its identity and counts answered', async () => {
  const writes = [];
  const host = { writeLarge: async (name, source, options) => {
    writes.push({ name, bytes: Buffer.from(await source.readAt(0, source.size)), options });
    return { state: 'finished', identity: `1f:${'cd'.repeat(32)}`, name, byte_length: source.size };
  } };
  const answer = await hearAndKeepARecording({ file: placedRecording(), model_path: '/m.bin' }, host, { hear: async () => heardWords(5000) });
  assert.deepEqual(answer, { identity: `1f:${HEX}`, transcript: `1f:${'cd'.repeat(32)}`, transcript_name: `/transcripts/${HEX}.json`, segments: 5000, duration: 5000, language: 'en', heard_whole: true, produced_by: 'ears' });
  assert.ok(JSON.stringify(answer).length < 600, `the answer stays small: ${JSON.stringify(answer).length} bytes`);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.mediaType, 'application/json');
  const kept = JSON.parse(writes[0].bytes);
  assert.equal(kept.identity, `1f:${HEX}`);
  assert.equal(kept.segments.length, 5000, 'the whole transcript is kept');
  assert.ok(writes[0].bytes.length > 100_000, 'a long transcript is the kept file, not the answer');
});

test('keep_transcript false answers the words and keeps nothing; a file not placed by identity is refused before keeping', async () => {
  const host = { writeLarge: async () => assert.fail('nothing is kept') };
  const answer = await hearAndKeepARecording({ file: placedRecording(), model_path: '/m.bin', keep_transcript: false }, host, { hear: async () => heardWords(2) });
  assert.equal(answer.segments.length, 2);
  assert.equal(answer.text, 'w w');
  const loose = join(tempFolder(join(tmpdir(), 'loose-')), 'talk.wav');
  writeFileSync(loose, 'x');
  await assert.rejects(hearAndKeepARecording({ file: loose, model_path: '/m.bin' }, host, { hear: async () => heardWords(1) }), /not handed to this run by its identity/);
  assert.equal(placedIdentity(`/run/inputs/${HEX}/a.wav`, '1f:'), `1f:${HEX}`);
  assert.equal(placedIdentity('/run/inputs/short/a.wav', '1f:'), null);
});
