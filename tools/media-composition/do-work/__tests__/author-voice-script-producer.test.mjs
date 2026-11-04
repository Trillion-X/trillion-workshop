import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorVoiceScript as produceVoiceScript, translateSourceComposition } from '../author-voice-script.mjs';

// Model/output tests do not execute or probe an installed dependency runtime. The copy rule is invented for the test.
const RULES = [{ id: 'no-delve', words: ['delve'], says: 'No delve.' }];
const authorVoiceScript = input => produceVoiceScript({ findProgram: () => ({ program: 'fixture-python', env: {} }), rules: RULES, ...input });
const narration = [
  { id: 'first', text: 'A person records an answer.', speaker: 'narrator', role: 'hook', source_refs: [{ id: 'source-a', relation: 'faithful-paraphrase' }] },
  { id: 'second', text: 'Keep the whole answer together.', speaker: 'guest', role: 'answer', source_refs: [{ id: 'source-b', relation: 'original-quotation', text: 'Delve into this unspoken source quote.' }] },
];
const base = () => ({ title: 'A complete recording', description: 'An assembled conversation about editing.', narration: structuredClone(narration),
  voices: { narrator: { engine: 'kokoro', voice: 'caller_voice', speed: 1 }, guest: { engine: 'piper', voice: 'caller_guest', speed: 1.05 } },
  source: { text: 'Unspoken source metadata stays outside narration.' } });

async function fixture(data = base()) {
  const temp = await mkdtemp(join(tmpdir(), 'source-compositions-producer-'));
  const folder = join(temp, 'fixture'); await mkdir(folder);
  const input = join(folder, 'copy-input.json');
  await writeFile(input, JSON.stringify(data));
  return { temp, folder, input, outdir: join(temp, 'voice-output') };
}

async function nativeOutput(argv, change = x => x) {
  const native = JSON.parse(await readFile(argv[3], 'utf8')), out = argv[5];
  await writeFile(join(out, 'timeline.json'), JSON.stringify({ duration: 1, lines: change(native.lines) }));
  const wav = Buffer.alloc(46); wav.write('RIFF', 0); wav.write('WAVE', 8);
  await writeFile(join(out, 'vo.wav'), wav);
  await writeFile(join(out, 'readback.json'), JSON.stringify({ suspects: [] }));
}

test('translates ordered words and speaker profiles while keeping source metadata in binding', () => {
  const result = translateSourceComposition(base());
  assert.deepEqual(result.lines, [
    { id: 'first', text: narration[0].text, engine: 'kokoro', voice: 'caller_voice', speed: 1 },
    { id: 'second', text: narration[1].text, engine: 'piper', voice: 'caller_guest', speed: 1.05 },
  ]);
  assert.equal(result.binding.narration[0].role, 'hook');
  assert.deepEqual(result.binding.narration[1].source_refs, narration[1].source_refs);
  assert.equal(JSON.stringify(result.lines).includes('Unspoken'), false);
  assert.throws(() => translateSourceComposition({ ...base(), voices: {} }), /No explicit native voice profile/);
});

test('an explicit speaker place remains bound and reaches the source producer', async t => {
  const data = { ...base(), place: 'existing-context' };
  assert.equal(translateSourceComposition(data).binding.place, data.place);
  assert.throws(() => translateSourceComposition({ ...data, place: '' }), /nonempty existing/);
  const f = await fixture(data); t.after(() => rm(f.temp, { recursive: true, force: true }));
  await authorVoiceScript({ input: f.input, outdir: f.outdir, run: async (_cmd, argv, opts) => {
    await opts.onStart();
    assert.equal(JSON.parse(await readFile(argv[3], 'utf8')).place, data.place);
    await nativeOutput(argv);
  } });
  assert.equal(JSON.parse(await readFile(join(f.outdir, 'source-binding.json'), 'utf8')).place, data.place);
});

test('copy check refuses missing rules, empty coverage, and selected bad words before producer', async t => {
  const badHook = base(); badHook.narration[0].text = 'Delve deeper.';
  for (const [data, pattern] of [
    [badHook, /finding/],
    [{ source: { text: 'Private source.' } }, /Nothing to check/],
  ]) {
    const f = await fixture(data); t.after(() => rm(f.temp, { recursive: true, force: true }));
    let calls = 0;
    await assert.rejects(authorVoiceScript({ input: f.input, outdir: f.outdir, run: async () => calls++ }), pattern);
    assert.equal(calls, 0);
  }
  const f = await fixture(); t.after(() => rm(f.temp, { recursive: true, force: true }));
  let calls = 0;
  await assert.rejects(authorVoiceScript({ input: f.input, outdir: f.outdir, rules: undefined, run: async () => calls++ }), /No copy rules/);
  assert.equal(calls, 0);
});

test('metadata-only quotations are excluded; selected spoken quotation is copy-checked', async t => {
  const f = await fixture(); t.after(() => rm(f.temp, { recursive: true, force: true }));
  let calls = 0;
  await authorVoiceScript({ input: f.input, outdir: f.outdir, run: async (_cmd, argv, opts) => {
    await opts.onStart(); calls++;
    const native = JSON.parse(await readFile(argv[3], 'utf8'));
    assert.deepEqual(native.lines.map(line => line.text), narration.map(row => row.text));
    await nativeOutput(argv);
  } });
  assert.equal(calls, 1);
  const quoted = base(); quoted.narration[1].text = 'Delve deeper.';
  await writeFile(f.input, JSON.stringify(quoted)); calls = 0;
  await assert.rejects(authorVoiceScript({ input: f.input, outdir: f.outdir, run: async () => calls++ }), /finding/);
  assert.equal(calls, 0);
});

test('exact restored bytes resume; source changes after producer remain stale; producer failure propagates', async t => {
  const f = await fixture(); t.after(() => rm(f.temp, { recursive: true, force: true }));
  const exact = await readFile(f.input);
  await writeFile(f.input, JSON.stringify({ ...base(), narration: [{ id: 'bad', text: 'Delve deeper.', speaker: 'narrator' }] }));
  let calls = 0;
  await assert.rejects(authorVoiceScript({ input: f.input, outdir: f.outdir, run: async () => calls++ }), /finding/);
  await writeFile(f.input, exact);
  await authorVoiceScript({ input: f.input, outdir: f.outdir, run: async (_cmd, argv, opts) => { await opts.onStart(); calls++; await nativeOutput(argv); } });
  assert.equal(calls, 1);
  const beforeChange = async (_cmd, _argv, opts) => { await opts.onStart(); await writeFile(f.input, Buffer.concat([exact, Buffer.from(' ')])); };
  await writeFile(f.input, exact);
  await assert.rejects(authorVoiceScript({ input: f.input, outdir: f.outdir, run: beforeChange }), /Stale source composition after producer/);
  await writeFile(f.input, exact);
  await assert.rejects(authorVoiceScript({ input: f.input, outdir: f.outdir, run: async () => { throw new Error('native producer failed'); } }), /native producer failed/);
});


test('native success must bind actual ordered words and WAV output; source epochs are recoverable', async t => {
  const f = await fixture(); t.after(() => rm(f.temp, { recursive: true, force: true }));
  await assert.rejects(authorVoiceScript({ input: f.input, outdir: f.outdir, run: async (_cmd, _argv, opts) => { await opts.onStart(); } }), /ENOENT/);
  await assert.rejects(authorVoiceScript({ input: f.input, outdir: f.outdir, run: async (_cmd, argv, opts) => { await opts.onStart(); await nativeOutput(argv, rows => [{ ...rows[0], text: 'Different spoken words.' }, ...rows.slice(1)]); } }), /words, order, or voice differ/);
  await authorVoiceScript({ input: f.input, outdir: f.outdir, run: async (_cmd, argv, opts) => { await opts.onStart(); await nativeOutput(argv); } });
  const changed = base(); changed.narration = [{ ...narration[0], text: 'A changed answer.' }];
  await writeFile(f.input, JSON.stringify(changed)); let calls = 0;
  await assert.rejects(authorVoiceScript({ input: f.input, outdir: f.outdir, run: async () => calls++ }), /another source epoch/);
  assert.equal(calls, 0);
});


test('one complete source answer is a valid opposing case; explicit timing survives translation', async t => {
  const data = base(); data.narration = [data.narration[0]]; data.gap = .4; data.tail = .8;
  const f = await fixture(data); t.after(() => rm(f.temp, { recursive: true, force: true }));
  const result = await authorVoiceScript({ input: f.input, outdir: f.outdir, run: async (_cmd, argv, opts) => {
    await opts.onStart(); const native = JSON.parse(await readFile(argv[3], 'utf8')); assert.equal(native.gap, .4); assert.equal(native.tail, .8);
    await nativeOutput(argv);
  } });
  assert.equal(result.lineCount, 1); assert.equal(result.nativeWordVoiceBinding, 'matched');
  assert.equal(result.authorAcceptance, false);
});


test('queued input or derived-word changes refuse at admitted start before voice effects', async t => {
  for (const target of ['input', 'native']) {
    const f = await fixture(); t.after(() => rm(f.temp, { recursive: true, force: true }));
    let effects = 0;
    await assert.rejects(authorVoiceScript({ input: f.input, outdir: f.outdir, run: async (_cmd, argv, opts) => {
      if (target === 'input') await writeFile(f.input, JSON.stringify({ ...base(), title: 'Changed while waiting.' }));
      else { const script = JSON.parse(await readFile(argv[3], 'utf8')); script.lines[0].text = 'Changed while waiting.'; await writeFile(argv[3], JSON.stringify(script)); }
      await opts.onStart(); effects++; await nativeOutput(argv);
    } }), /Stale source composition|Derived voice script changed/);
    assert.equal(effects, 0);
    assert.equal(JSON.parse(await readFile(join(f.outdir, 'source-binding.json'), 'utf8')).state, 'stale_epoch');
  }
});

test('installed launcher paths are refused; producer source is owned', async t => {
  const f = await fixture(); t.after(() => rm(f.temp, { recursive: true, force: true }));
  await assert.rejects(authorVoiceScript({ input: f.input, outdir: f.outdir, showtime: '/unowned/showtime' }), /not a source owner/);
  await authorVoiceScript({ input: f.input, outdir: f.outdir, run: async (cmd, argv, opts) => {
    assert.match(argv[0], /tools\/media-composition\/do-work\/narration\/produce[.]py$/);
    assert.equal(argv.includes('/unowned/showtime'), false);
    assert.equal(opts.env.TRILLION_NARRATION_NODE, process.execPath);
    await opts.onStart(); await nativeOutput(argv);
  } });
});
