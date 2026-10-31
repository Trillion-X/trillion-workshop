// generate_speech.py on synthetic requests: the local voice provider (with stand-in voice programs, so no real
// voice is needed) makes a real WAV file, and every way a provider can fail or answer with nothing is an honest
// error, never made-up audio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const here = import.meta.dirname;
const command = join(here, '..', 'do-work', 'generate_speech.py');
const localVoice = join(here, '..', 'do-work', 'local_voice_provider.py');
const python = spawnSync('python3', ['--version']);
const skip = python.status !== 0 && 'python3 is missing';

// A stand-in voice program: writes half a second of silence as a WAV where -o or -w says, and notes its arguments.
function standIn(dir, name) {
  const file = join(dir, name);
  writeFileSync(file, `#!/usr/bin/env python3
import sys, wave
args = sys.argv[1:]
open(sys.argv[0] + '.args', 'w').write(' '.join(args))
path = args[args.index('-o') + 1] if '-o' in args else args[args.index('-w') + 1]
with wave.open(path, 'wb') as audio:
    audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(22050)
    audio.writeframes(b'\\x00\\x00' * 11025)
`);
  chmodSync(file, 0o755);
  return file;
}

function run(request, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'generate-speech-'));
  const requestFile = join(dir, 'request.json');
  writeFileSync(requestFile, JSON.stringify(request));
  const out = join(dir, 'speech');
  const done = spawnSync('python3', [command, '--request', requestFile, '--out', out], { encoding: 'utf8', env: { ...process.env, ...env } });
  const last = done.stdout.trim().split('\n').at(-1);
  return { status: done.status, result: JSON.parse(last).result, out, dir };
}

function providerScript(dir, body) {
  const file = join(dir, 'provider.py');
  writeFileSync(file, `import json, sys\nrequest = json.load(open(sys.argv[1]))\n${body}\n`);
  return file;
}

const withLocalVoice = (options = {}) => ({
  request_id: 'req 1',
  text: 'Fresh bread at seven.',
  voice_profile_ref: 'voice:warm',
  requested_at: '2030-01-01T00:00:00Z',
  options,
  provider: { argv: ['python3', localVoice, '--request-json', '{request}', '--output-json', '{output}'] },
});

function withStandIns(names) {
  const dir = mkdtempSync(join(tmpdir(), 'voices-'));
  for (const name of names) standIn(dir, name);
  return { dir, env: { PATH: dir + delimiter + process.env.PATH } };
}

test('the local voice provider gives a real WAV file and a result that names it', { skip }, () => {
  const { dir, env } = withStandIns(['say']);
  const { status, result, out } = run(withLocalVoice({ voice: 'Maple', language: 'en' }), env);
  assert.equal(status, 0);
  assert.equal(result.kind, 'speech-generation.result');
  assert.equal(result.request_id, 'req 1');
  assert.equal(result.voice_profile_ref, 'voice:warm');
  assert.equal(result.provider_ref, 'local-voice:say');
  assert.equal(result.format, 'audio/wav');
  assert.equal(result.language, 'en');
  assert.equal(result.duration_ms, 500);
  const [ref] = result.output_artifact_refs;
  assert.equal(ref.path, 'req_1-1.wav');
  assert.equal(result.src, 'req_1-1.wav');
  assert.equal('src' in ref, false);
  const bytes = readFileSync(join(out, ref.path));
  assert.equal(bytes.length, ref.byte_length);
  assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
  assert.match(readFileSync(join(dir, 'say.args'), 'utf8'), /-v Maple .*-o .* Fresh bread at seven\./);
});

test('a program that is not on this computer is skipped for the next one asked for', { skip }, () => {
  const { env } = withStandIns(['espeak-ng']);
  const { status, result } = run(withLocalVoice({ engines: ['no-such-voice-program', 'espeak-ng'] }), env);
  assert.equal(status, 0);
  assert.equal(result.provider_ref, 'local-voice:espeak-ng');
});

test('no voice program at all is an error that names each one tried', { skip }, () => {
  const { status, result } = run(withLocalVoice({ engines: ['no-such-voice-program'] }));
  assert.equal(status, 2);
  assert.equal(result.code, 'speech_provider_failed');
  assert.equal(result.details.exit_code, 1);
  assert.match(result.details.stderr, /no-such-voice-program: not found/);
});

test('nothing to say is the honest answer: exit 2, nothing written', { skip }, () => {
  const { status, result, out } = run({ ...withLocalVoice(), text: '   ' });
  assert.equal(status, 2);
  assert.equal(result.code, 'speech_generation_empty_text');
  assert.equal(existsSync(out), false);
});

test('no provider is the honest answer: exit 2, nothing written', { skip }, () => {
  const { status, result, out } = run({ request_id: 'req 2', text: 'anything', voice_profile_ref: 'voice:warm' });
  assert.equal(status, 2);
  assert.equal(result.kind, 'speech-generation.error');
  assert.equal(result.code, 'speech_provider_missing');
  assert.equal(result.voice_profile_ref, 'voice:warm');
  assert.equal(existsSync(out), false);
});

test('a provider that answers without audio is an error that lists what it answered', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-'));
  const script = providerScript(dir, "json.dump({'provider_ref': 'x'}, open(sys.argv[2], 'w'))");
  const { status, result } = run({ request_id: 'r', text: 'hello', provider: { argv: ['python3', script, '{request}', '{output}'] } });
  assert.equal(status, 2);
  assert.equal(result.code, 'speech_generation_command_output_missing_artifacts');
  assert.deepEqual(result.details.available_keys, ['provider_ref']);
});

test('a provider that fails says how: exit code and what it printed', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-'));
  const script = providerScript(dir, "sys.stderr.write('no account'); sys.exit(3)");
  const { status, result } = run({ request_id: 'r', text: 'hello', provider: { argv: ['python3', script, '{request}', '{output}'] } });
  assert.equal(status, 2);
  assert.equal(result.code, 'speech_provider_failed');
  assert.equal(result.details.exit_code, 3);
  assert.match(result.details.stderr, /no account/);
});

test('a provider program that is not there is named', { skip }, () => {
  const { status, result } = run({ request_id: 'r', text: 'hello', provider: { argv: ['no-such-voice-program-here', '{request}'] } });
  assert.equal(status, 2);
  assert.equal(result.code, 'speech_provider_not_found');
  assert.equal(result.details.program, 'no-such-voice-program-here');
});

test('an answer that is not JSON is named', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-'));
  const script = providerScript(dir, "open(sys.argv[2], 'w').write('not json')");
  const { status, result } = run({ request_id: 'r', text: 'hello', provider: { argv: ['python3', script, '{request}', '{output}'] } });
  assert.equal(status, 2);
  assert.equal(result.code, 'speech_provider_answer_unreadable');
});

test('a hosted answer by url is kept as the url, with no file made', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-'));
  const script = providerScript(dir, "json.dump({'output_artifact_refs': [{'url': 'https://voices.example.test/a.mp3', 'media_type': 'audio/mpeg'}], 'format': 'audio/mpeg', 'duration_ms': 1200}, open(sys.argv[2], 'w'))");
  const { status, result, out } = run({ request_id: 'r', text: 'hello', provider: { argv: ['python3', script, '{request}', '{output}'] } });
  assert.equal(status, 0);
  assert.equal(result.src, 'https://voices.example.test/a.mp3');
  assert.equal(result.duration_ms, 1200);
  assert.deepEqual(readdirSync(out).filter(name => !name.startsWith('.')), []);
});

test('the provider sees only the variables the request names, and never the provider command itself', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-'));
  const script = providerScript(dir, "import os\njson.dump({'output_artifact_refs': [{'url': 'u'}], 'provider_ref': (os.environ.get('NAMED_ONE') or '-') + '/' + (os.environ.get('NOT_NAMED') or '-') + '/' + str('provider' in request)}, open(sys.argv[2], 'w'))");
  const { result } = run(
    { request_id: 'r', text: 'hello', provider: { argv: ['python3', script, '{request}', '{output}'], env_names: ['NAMED_ONE'] } },
    { NAMED_ONE: 'seen', NOT_NAMED: 'hidden' },
  );
  assert.equal(result.provider_ref, 'seen/-/False');
});
