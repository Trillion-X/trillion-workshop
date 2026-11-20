// The no-GPU switch reaches the whisper-cli command: the transcribe script adds -ng only when BITFIELD_WHISPER_NO_GPU is 1
// (the Metal back end compiles its shaders through xcrun, which a computer sandbox may block). The test runs the real
// run_whisper with a fake whisper-cli that writes the arguments it was given.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'do-work', 'process-scripts', 'transcribe-audio.py');
const PROBE = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("transcribe_audio", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.normalize_audio = lambda audio, request_id, output: audio
module.ensure_model = lambda model, url: None
module.run_whisper(sys.argv[2], "request-1", sys.argv[3])
`;

function whisperArgs(noGpu) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'whisper-no-gpu-'));
  const fake = path.join(dir, 'whisper-cli');
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv.txt"\nexit 1\n`);
  chmodSync(fake, 0o755);
  const env = { ...process.env, BITFIELD_WHISPER_CLI_PATH: fake, BITFIELD_WHISPER_MODEL_PATH: path.join(dir, 'model.bin') };
  delete env.BITFIELD_WHISPER_NO_GPU;
  if (noGpu) env.BITFIELD_WHISPER_NO_GPU = '1';
  const run = spawnSync('python3', ['-I', '-c', PROBE, SCRIPT, path.join(dir, 'audio.wav'), path.join(dir, 'out.json')], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return readFileSync(path.join(dir, 'argv.txt'), 'utf8').trim().split('\n');
}

test('the whisper-cli command gets -ng only when the no-GPU switch is on', () => {
  assert.ok(whisperArgs(true).includes('-ng'), 'the switch on adds -ng');
  assert.ok(!whisperArgs(false).includes('-ng'), 'the switch off leaves the GPU command as it was');
});
