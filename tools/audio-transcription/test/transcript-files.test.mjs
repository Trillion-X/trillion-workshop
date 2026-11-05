// Runs test/test_transcript_files.py: the transcript-file readers in do-work/ (read_transcript_files, pick_transcript_files,
// caption_transcripts, find_whisper_quotes, show_segments) and judge --durations / text --header, on made-up files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const python = spawnSync('python3', ['--version']).status === 0;

test('the transcript-file readers keep their promises', { skip: !python && 'needs python3' }, () => {
  const out = spawnSync('python3', ['-B', join(folder, 'test', 'test_transcript_files.py')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
});
