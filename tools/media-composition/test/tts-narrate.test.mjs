// The narration producer is the first speech program the computer has, never one picked by the computer's kind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NARRATE = fileURLToPath(new URL('../do-work/tts-narrate.mjs', import.meta.url));

// A pretend computer: a folder of stand-in programs and nothing else on PATH.
function computerWith(programs) {
  const folder = mkdtempSync(join(tmpdir(), 'tts-computer-'));
  const write = (name, body) => { writeFileSync(join(folder, name), `#!/bin/sh\n${body}\n`); chmodSync(join(folder, name), 0o755); };
  if (programs.includes('espeak-ng')) write('espeak-ng', 'while [ "$1" != "-w" ]; do shift; done; printf voice > "$2"');
  write('ffmpeg', 'for last; do :; done; printf wav > "$last"');
  write('ffprobe', 'echo 1.5');
  return { folder, env: { PATH: folder, MEDIA_FFMPEG_BIN: join(folder, 'ffmpeg'), MEDIA_FFPROBE_BIN: join(folder, 'ffprobe') } };
}

test('with no producer named, the first speech program the computer has is used', () => {
  const { folder, env } = computerWith(['espeak-ng']);
  const out = join(folder, 'line.wav');
  const ran = spawnSync(process.execPath, [NARRATE, 'Hello there', out], { encoding: 'utf8', env });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout.trim()), { out, producer: 'espeak-ng', voice: null, duration: 1.5 });
  assert.ok(existsSync(out));
});

test('a computer with no speech program is told what to install, and nothing is made', () => {
  const { folder, env } = computerWith([]);
  const ran = spawnSync(process.execPath, [NARRATE, 'Hello there', join(folder, 'line.wav')], { encoding: 'utf8', env });
  assert.equal(ran.status, 2);
  assert.match(ran.stderr, /this computer has none of the speech programs a producer starts \(say, espeak-ng\)/);
  assert.equal(existsSync(join(folder, 'line.wav')), false);
});
