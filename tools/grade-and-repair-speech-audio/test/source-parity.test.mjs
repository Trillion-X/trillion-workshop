// Compare the actual immutable source algorithms with their ports on one synthetic take.
// Private source addresses stay in the contracts; no recording, model or provider is used.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pythonForTests } from 'trillion-workshop/test-helpers/python-environment.mjs';
import { gitReaders } from 'trillion-workshop/tools/check-a-port-against-its-source/do-work/read-from-repositories.mjs';
import { makeHashCodeHexFromBytes } from 'trillion-workshop/tools/content-identity/read-data/identity.mjs';

const folder = fileURLToPath(new URL('..', import.meta.url));
const root = dirname(fileURLToPath(import.meta.resolve('trillion-workshop/package.json')));
const here = join(folder, 'test');
const python = pythonForTests('audio');
const readers = gitReaders({ root });
const names = ['check-voice-take', 'clean-voice-take-pauses', 'tighten-word-starts'];
const contracts = new Map(names.map(name => [name, JSON.parse(readFileSync(join(folder, 'ports', `${name}.json`), 'utf8'))]));
const unavailable = names.filter(name => !readers.checkout(contracts.get(name).sources[0].repository));
const skip = unavailable.length ? 'private source repository unavailable here; source parity remains unproved' : false;
let work, original, current, take;

function run(script, args, label) {
  const result = spawnSync(python, [script, ...args], {
    cwd: work, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', NUMBA_CACHE_DIR: join(work, 'numba-cache'),
      MPLCONFIGDIR: join(work, 'plot-cache'), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
  });
  // The reference can contain private documentation. Report execution facts, never its source or stderr.
  assert.equal(result.error?.code, undefined, `${label}: ${result.error?.code}`);
  assert.equal(result.status, 0, `${label}: exit ${result.status}, signal ${result.signal ?? 'none'}`);
  return result;
}

function pinnedOriginal(name) {
  const contract = contracts.get(name), source = contract.sources[0];
  const bytes = readers.readSource(source);
  assert.ok(Buffer.isBuffer(bytes), `${contract.id}: immutable source must be readable`);
  let selected = bytes;
  if (source.lines) {
    const [first, last] = source.lines;
    selected = Buffer.from(`${bytes.toString('utf8').split('\n').slice(first - 1, last).join('\n')}\n`);
  }
  assert.equal(makeHashCodeHexFromBytes(selected), source.multihash, `${contract.id}: source identity drift`);
  const path = join(original, `${name}.py`);
  // A temporary reference execution input, never another checkout or production source owner.
  writeFileSync(path, bytes);
  return path;
}

before(() => {
  if (skip) return;
  work = tempFolder(join(tmpdir(), 'speech-source-parity-'));
  original = join(work, 'original'); current = join(work, 'current'); take = join(work, 'input');
  for (const path of [original, current]) mkdirSync(path);
  run(join(here, 'voice_take_fixture.py'), [take], 'synthetic take fixture');
  for (const destination of [original, current]) {
    cpSync(join(take, 'take.wav'), join(destination, 'take.wav'));
    cpSync(join(take, 'take.words.json'), join(destination, 'take.words.json'));
  }
});
after(() => { if (work && existsSync(work)) rmSync(work, { recursive: true, force: true }); });

test('source parity: every word QC measure and flag equals the original at both offsets', { skip }, t => {
  const baseline = pinnedOriginal('check-voice-take');
  const target = join(root, contracts.get('check-voice-take').targets[0].path);
  for (const offset of ['0', '0.15']) {
    run(baseline, [join(original, 'take.wav'), join(original, 'take.words.json'), offset], 'original word QC');
    run(target, [join(current, 'take.wav'), join(current, 'take.words.json'), offset], 'ported word QC');
    const expected = JSON.parse(readFileSync(join(original, 'take.qc.json'), 'utf8'));
    const actual = JSON.parse(readFileSync(join(current, 'take.qc.json'), 'utf8'));
    assert.equal(expected.length, 5);
    assert.deepEqual(actual, expected, 'all words, metrics, times and flags match without tolerance');
    assert.ok(actual.some(row => row.word === 'charlie' && row.flags.some(flag => flag.startsWith('click'))));
  }
  t.diagnostic('5 words at 2 offsets; every metric and flag exactly equal');
});

test('source parity: pause cleaning produces identical WAV bytes and leaves the input unchanged', { skip }, t => {
  const baseline = pinnedOriginal('clean-voice-take-pauses');
  const target = join(root, contracts.get('clean-voice-take-pauses').targets[0].path);
  const input = join(take, 'take.wav'), bytes = readFileSync(input);
  const oldOut = join(original, 'clean.wav'), newOut = join(current, 'clean.wav');
  run(baseline, [input, oldOut], 'original pause cleaning');
  run(target, [input, newOut], 'ported pause cleaning');
  assert.deepEqual(readFileSync(newOut), readFileSync(oldOut), 'all WAV bytes match, including samples and format');
  assert.deepEqual(readFileSync(input), bytes, 'neither implementation changes the synthetic input');
  t.diagnostic(`WAV bytes exactly equal: ${makeHashCodeHexFromBytes(readFileSync(newOut))}`);
});

test('source parity: word starts, spelling, hyphen joining and mismatch fallback equal the original', { skip }, t => {
  const baseline = pinnedOriginal('tighten-word-starts');
  const target = join(root, contracts.get('tighten-word-starts').targets[0].path);
  const fixtureWords = JSON.parse(readFileSync(join(take, 'take.words.json'), 'utf8'));
  const cases = [
    { name: 'without-script', words: fixtureWords },
    { name: 'script-spelling', words: fixtureWords, script: 'Alfa bravo charlie delta echo' },
    { name: 'mismatched-script', words: fixtureWords, script: 'Different count' },
    { name: 'hyphen-joined', words: { words: fixtureWords.words.map((word, index) =>
      ({ ...word, text: index === 0 ? 'nutrient' : index === 1 ? '-dense' : word.text })) },
      script: 'Nutrient-dense charlie delta echo' },
  ];
  for (const item of cases) {
    const words = join(take, `${item.name}.json`), line = join(take, `${item.name}-line.json`);
    writeFileSync(words, JSON.stringify(item.words));
    if (item.script) writeFileSync(line, JSON.stringify({ script: item.script }));
    const oldOut = join(original, `${item.name}.json`), newOut = join(current, `${item.name}.json`);
    const args = [join(take, 'take.wav'), words];
    run(baseline, [...args, oldOut, ...(item.script ? [line] : [])], 'original word starts');
    run(target, [...args, newOut, ...(item.script ? [line] : [])], 'ported word starts');
    const expected = JSON.parse(readFileSync(oldOut, 'utf8'));
    const actual = JSON.parse(readFileSync(newOut, 'utf8'));
    assert.deepEqual(actual, expected, `${item.name}: the complete word-time result matches`);
    if (item.name === 'script-spelling') assert.equal(actual.words[0].text, 'Alfa');
    if (item.name === 'hyphen-joined') assert.equal(actual.words[0].text, 'Nutrient-dense');
    if (item.name === 'mismatched-script') assert.equal(actual.words[0].text, fixtureWords.words[0].text);
  }
  t.diagnostic('4 word-time/spelling cases exactly equal; no word ends moved');
});
