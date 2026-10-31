// generate_images.py on synthetic requests: the placeholder provider makes a real PNG, and every way a provider can
// fail or answer with nothing is an honest error, never a made-up image.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const here = import.meta.dirname;
const command = join(here, '..', 'do-work', 'generate_images.py');
const placeholder = join(here, '..', 'do-work', 'placeholder_image_provider.py');
const python = spawnSync('python3', ['--version']);

function run(request, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'generate-images-'));
  const requestFile = join(dir, 'request.json');
  writeFileSync(requestFile, JSON.stringify(request));
  const out = join(dir, 'images');
  const done = spawnSync('python3', [command, '--request', requestFile, '--out', out], { encoding: 'utf8', env: { ...process.env, ...env } });
  const last = done.stdout.trim().split('\n').at(-1);
  return { status: done.status, result: JSON.parse(last).result, out, dir };
}

function providerScript(dir, body) {
  const file = join(dir, 'provider.py');
  writeFileSync(file, `import json, sys\nrequest = json.load(open(sys.argv[1]))\n${body}\n`);
  return file;
}

const withPlaceholder = prompt => ({
  request_id: 'req 1',
  prompt,
  requested_at: '2030-01-01T00:00:00Z',
  provider: { argv: ['python3', placeholder, '--request-json', '{request}', '--output-json', '{output}'] },
});

test('the placeholder provider gives a real PNG file and a result that names it', { skip: python.status !== 0 && 'python3 is missing' }, () => {
  const { status, result, out } = run(withPlaceholder('a red door'));
  assert.equal(status, 0);
  assert.equal(result.kind, 'image-generation.result');
  assert.equal(result.request_id, 'req 1');
  assert.equal(result.prompt, 'a red door');
  assert.equal(result.format, 'image/png');
  assert.equal(result.provider_ref, 'placeholder-image-provider');
  const [ref] = result.output_artifact_refs;
  assert.equal(ref.path, 'req_1-1.png');
  assert.equal(result.src, 'req_1-1.png');
  assert.equal('src' in ref, false);
  const bytes = readFileSync(join(out, ref.path));
  assert.equal(bytes.length, ref.byte_length);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('the same prompt gives the same picture and another prompt another', () => {
  const first = run(withPlaceholder('a red door'));
  const again = run(withPlaceholder('a red door'));
  const other = run(withPlaceholder('a blue boat'));
  const read = r => readFileSync(join(r.out, r.result.output_artifact_refs[0].path));
  assert.deepEqual(read(first), read(again));
  assert.notDeepEqual(read(first), read(other));
});

test('no provider is the honest answer: exit 2, nothing written', () => {
  const { status, result, out } = run({ request_id: 'req 2', prompt: 'anything' });
  assert.equal(status, 2);
  assert.equal(result.kind, 'image-generation.error');
  assert.equal(result.code, 'image_provider_missing');
  assert.equal(existsSync(out), false);
});

test('a provider that answers without an image is an error that lists what it answered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-'));
  const script = providerScript(dir, "json.dump({'provider_ref': 'x'}, open(sys.argv[2], 'w'))");
  const { status, result } = run({ request_id: 'r', prompt: 'p', provider: { argv: ['python3', script, '{request}', '{output}'] } });
  assert.equal(status, 2);
  assert.equal(result.code, 'image_generation_command_output_missing_artifacts');
  assert.deepEqual(result.details.available_keys, ['provider_ref']);
});

test('a provider that fails says how: exit code and what it printed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-'));
  const script = providerScript(dir, "sys.stderr.write('no account'); sys.exit(3)");
  const { status, result } = run({ request_id: 'r', prompt: 'p', provider: { argv: ['python3', script, '{request}', '{output}'] } });
  assert.equal(status, 2);
  assert.equal(result.code, 'image_provider_failed');
  assert.equal(result.details.exit_code, 3);
  assert.match(result.details.stderr, /no account/);
});

test('a provider program that is not there is named', () => {
  const { status, result } = run({ request_id: 'r', prompt: 'p', provider: { argv: ['no-such-image-program-here', '{request}'] } });
  assert.equal(status, 2);
  assert.equal(result.code, 'image_provider_not_found');
});

test('a hosted answer by url is kept as the url, with no file made', () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-'));
  const script = providerScript(dir, "json.dump({'output_artifact_refs': [{'url': 'https://images.example.test/a.png', 'media_type': 'image/png'}], 'format': 'image/png'}, open(sys.argv[2], 'w'))");
  const { status, result, out } = run({ request_id: 'r', prompt: 'p', provider: { argv: ['python3', script, '{request}', '{output}'] } });
  assert.equal(status, 0);
  assert.equal(result.src, 'https://images.example.test/a.png');
  assert.deepEqual(readdirSync(out).filter(name => !name.startsWith('.')), []);
});

test('the provider sees only the variables the request names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-'));
  const script = providerScript(dir, "import os\njson.dump({'output_artifact_refs': [{'url': 'u'}], 'provider_ref': (os.environ.get('NAMED_ONE') or '-') + '/' + (os.environ.get('NOT_NAMED') or '-')}, open(sys.argv[2], 'w'))");
  const { result } = run(
    { request_id: 'r', prompt: 'p', provider: { argv: ['python3', script, '{request}', '{output}'], env_names: ['NAMED_ONE'] } },
    { NAMED_ONE: 'seen', NOT_NAMED: 'hidden' },
  );
  assert.equal(result.provider_ref, 'seen/-');
});
