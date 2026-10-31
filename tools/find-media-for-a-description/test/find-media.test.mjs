// find_media.mjs: table dispatch with zero provider branches, the bank provider end to end on a made-up bank, argv
// template filling, constraint enforcement from provider data, and one-row provider extensibility.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const resolver = join(root, 'do-work', 'find_media.mjs');
const work = mkdtempSync(join(tmpdir(), 'find-media-'));

function find(request, providersFile) {
  const extra = providersFile ? ['--providers', providersFile] : [];
  const done = spawnSync('node', [resolver, ...extra], { input: JSON.stringify(request), encoding: 'utf8', cwd: tmpdir() });
  const last = done.stdout.trim().split('\n').at(-1);
  return { status: done.status, stderr: done.stderr, result: done.status === 0 ? JSON.parse(last).result : null };
}

let bank;
before(() => {
  bank = mkdtempSync(join(tmpdir(), 'bank-'));
  writeFileSync(join(bank, 'harbour-sunrise.mp4'), 'clipbytes');
  writeFileSync(join(bank, 'harbour-sunrise.mp4.tags.json'), JSON.stringify({ tags: ['harbour', 'boats', 'sunrise'] }));
  writeFileSync(join(bank, 'forest-path.mp4'), 'clipbytes2');
  writeFileSync(join(bank, 'forest-path.mp4.tags.json'), JSON.stringify({ tags: ['nature', 'trees'] }));
  writeFileSync(join(bank, 'harbour-map.png'), 'stillbytes');
});

test('bank provider finds a tagged clip end to end', () => {
  const out = join(work, 'picked.mp4');
  const { status, result } = find({ provider: 'bank', description: 'boats at sunrise', kind: 'clip', bank_dir: bank, out });
  assert.equal(status, 0);
  assert.equal(result.provider, 'bank');
  assert.equal(readFileSync(out, 'utf8'), 'clipbytes', 'best-scoring clip copied');
});

test('bank provider honors kind (still vs clip extension classes)', () => {
  const out = join(work, 'picked.png');
  const { result } = find({ provider: 'bank', description: 'harbour map', kind: 'still', bank_dir: bank, out });
  assert.equal(readFileSync(out, 'utf8'), 'stillbytes');
  assert.equal(result.request.kind, 'still');
});

test('bank fails loudly when nothing matches', () => {
  const { status } = find({ provider: 'bank', description: 'spaceship', kind: 'clip', bank_dir: bank, out: join(work, 'x.mp4') });
  assert.notEqual(status, 0);
});

test('unknown provider fails listing the table (no silent default)', () => {
  const { status, stderr } = find({ provider: 'hologram', description: 'x', kind: 'clip', out: join(work, 'y.mp4') });
  assert.notEqual(status, 0);
  assert.match(stderr, /unknown provider/);
});

test('kind and license constraints come from provider data', () => {
  const providersFile = join(work, 'constraints.json');
  writeFileSync(providersFile, JSON.stringify({ providers: [{ id: 'clips-only', kind_support: ['clip'], licenses: ['owned'], run: { argv: ['node', '-v'], timeout_ms: 10000 } }] }));
  assert.match(find({ provider: 'clips-only', description: 'x', kind: 'still', out: join(work, 'z.png') }, providersFile).stderr, /does not support kind "still"/);
  assert.match(find({ provider: 'clips-only', description: 'x', kind: 'clip', license: 'editorial', out: join(work, 'z.mp4') }, providersFile).stderr, /cannot satisfy license "editorial"/);
  // the shipped stock row offers only cc0
  assert.match(find({ provider: 'stock', description: 'x', kind: 'clip', license: 'editorial', out: join(work, 'w.mp4') }).stderr, /cannot satisfy license "editorial"/);
});

test('the resolver has zero provider branches (no provider ids in code)', () => {
  const source = readFileSync(resolver, 'utf8');
  for (const id of ["'bank'", "'stock'", '"bank"', '"stock"']) {
    assert.equal(source.includes(id), false, `resolver does not name ${id}`);
  }
});

test('adding a provider is one data row: a made-up provider dispatches with no code change', () => {
  const providersFile = join(work, 'providers.json');
  const echo = join(work, 'echo-provider.mjs');
  writeFileSync(echo, `import { writeFileSync } from 'node:fs';
const out = process.argv[process.argv.indexOf('--out') + 1];
writeFileSync(out, 'synthbytes');
`);
  writeFileSync(providersFile, JSON.stringify({ providers: [{
    id: 'synth', label: 'Synth', kind_support: ['clip'], licenses: ['owned'],
    run: { argv: ['node', echo, '--out', '{request.out}'], timeout_ms: 10000 },
  }] }));
  const out = join(work, 'synth.mp4');
  const { result } = find({ provider: 'synth', description: 'anything', kind: 'clip', out }, providersFile);
  assert.equal(result.provider, 'synth');
  assert.equal(readFileSync(out, 'utf8'), 'synthbytes');
});

test('the shipped provider table is the person\'s own media and the free-licence libraries, with no vendor in it', () => {
  const table = JSON.parse(readFileSync(join(root, 'read-data', 'media-providers.json'), 'utf8'));
  assert.deepEqual(table.providers.map((p) => p.id).sort(), ['bank', 'stock']);
  assert.deepEqual(table.providers.find((p) => p.id === 'stock').licenses, ['cc0'], 'free licence only');
  assert.equal(/pexels|pixabay/i.test(JSON.stringify(table)), false);
});
