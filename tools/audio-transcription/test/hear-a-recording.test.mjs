// tools/audio-transcription/test/hear-a-recording.test.mjs
//
// read-data/hear-here.mjs (tool:hear-a-recording): a recording is read whole through the run's door into the run's own
// folder, heard there and removed; the seam's transcript answers as { text, segments, language }; a request without a
// file or a model is refused before anything is read; the answer holds the words and nothing is written back.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hearARecording, hearFile } from '../read-data/hear-here.mjs';

const fileDoor = (bytes, calls = []) => ({
  calls,
  async files(method, request) {
    calls.push({ method, request });
    if (method === 'find_file') return { names: ['/Recordings/a-talk.m4a'] };
    if (method === 'read_file') {
      const part = bytes.subarray(request.offset, request.offset + request.length);
      return { byte_length: bytes.length, bytes_returned: part.length, content: part.toString('base64'), encoding: 'base64' };
    }
    if (method === 'write_file_start') return { next_offset: 0 };
    if (method === 'write_file_finish') return { identity: `id:${request.name}` };
    return {};
  },
});

test('a recording is read through the door, heard in the run folder, and the copy is removed', async () => {
  const door = fileDoor(Buffer.from('sound bytes'));
  let heardAt = null;
  const answer = await hearARecording({ file: '/Recordings/a-talk.m4a' }, { door }, {
    hear: async file => { heardAt = file; assert.equal(existsSync(file), true); return { text: 'hi there', segments: [{ start: 0, end: 1, text: 'hi there' }], language: 'en', produced_by: 'ears' }; },
  });
  assert.deepEqual(answer, { text: 'hi there', segments: [{ start: 0, end: 1, text: 'hi there' }], language: 'en', produced_by: 'ears', heard_whole: true });
  assert.match(heardAt, /recording\.m4a$/);
  assert.equal(existsSync(heardAt), false);
  assert.deepEqual(door.calls.map(call => call.method), ['find_file', 'read_file']);
});

test('without a file or a model nothing is read', async () => {
  const door = fileDoor(Buffer.from('x'));
  await assert.rejects(hearARecording({}, { door }), /Give `file`/);
  await assert.rejects(hearARecording({ file: 'f' }, { door }), /Give model_path/);
  assert.equal(door.calls.length, 0);
});

test("the seam's transcript is answered as text, segments and language", async () => {
  const folder = mkdtempSync(join(tmpdir(), 'seam-'));
  const script = join(folder, 'seam.py');
  writeFileSync(script, `import json, sys\nargs = sys.argv\nout = args[args.index('--out') + 1]\nassert args[args.index('--whisper-cli') + 1] == '/granted/whisper-cli'\njson.dump({"segments": [{"start": 0, "end": 2, "text": " hello ", "words": []}], "full_text": "hello", "language": "en"}, open(out, "w"))\n`);
  const audio = join(folder, 'a.wav');
  writeFileSync(audio, 'x');
  const heard = await hearFile(audio, { modelPath: '/models/m.bin', whisperCli: '/granted/whisper-cli', script });
  assert.deepEqual(heard, { text: 'hello', segments: [{ start: 0, end: 2, text: 'hello' }], language: 'en', produced_by: 'whisper-cli on this computer' });
  assert.equal(existsSync(`${audio}.heard.json`), false);
});
