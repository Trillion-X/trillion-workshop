// tools/media-composition/test/suggest-media-cuts-transcript-file.test.mjs
//
// tool:suggest-media-cuts reads a transcript the hearing tool kept in Files from its placed local path (`transcript_file`)
// the same as one handed in (`transcript`), so a long recording's words never ride in a workflow step's answer.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { suggestMediaCuts, transcriptOfFile } from '../do-work/suggest-media-cuts.mjs';

const words = [
  { start: 0, end: 0.4, text: 'so' }, { start: 0.5, end: 0.9, text: 'um' }, { start: 3.5, end: 3.9, text: 'today' },
  { start: 4, end: 4.4, text: 'we' }, { start: 4.5, end: 4.9, text: 'cut' },
];

test('a kept transcript file gives the same proposals as the transcript handed in', async () => {
  const file = join(tempFolder(join(tmpdir(), 'kept-transcript-')), 'a.json');
  writeFileSync(file, JSON.stringify({ identity: `1f:${'ab'.repeat(32)}`, text: 'so um today we cut', segments: words }));
  assert.deepEqual(transcriptOfFile(file), { segments: [{ words }] });
  const handed = await suggestMediaCuts({ identity: 'rec', mode: 'silent_pauses', transcript: { segments: [{ words }] } });
  const fromFile = await suggestMediaCuts({ identity: 'rec', mode: 'silent_pauses', transcript_file: file });
  assert.deepEqual(fromFile, handed);
});

test('a transcript file with no segments is refused', () => {
  const file = join(tempFolder(join(tmpdir(), 'kept-transcript-')), 'b.json');
  writeFileSync(file, JSON.stringify({ text: 'x' }));
  assert.throws(() => transcriptOfFile(file), /no segments/);
});
