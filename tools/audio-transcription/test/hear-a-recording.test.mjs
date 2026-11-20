// tools/audio-transcription/test/hear-a-recording.test.mjs
//
// read-data/hear-here.mjs (tool:hear-a-recording): a recording is read by name through the run's host (host.readWholeFile),
// heard in the run's own folder and removed; the seam's transcript answers as { text, segments, language }; a request
// without a file or a model is refused before anything is read, and a file above the size the run reads is refused.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hearARecording, hearFile } from '../read-data/hear-here.mjs';

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
  assert.deepEqual(heard, { text: 'hello', segments: [{ start: 0, end: 2, text: 'hello' }], language: 'en', produced_by: 'whisper-cli on this computer' });
  assert.equal(existsSync(`${audio}.heard.json`), false);
});
