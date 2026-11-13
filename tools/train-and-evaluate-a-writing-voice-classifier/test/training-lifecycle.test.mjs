import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildTrainingDataset, fileBytes, requiredModel, runPython, validateFamilySplit, validateModelFiles,
  PYTHON_DEPENDENCIES_DIR, PYTHON_PROGRAM } from '../read-data/training-lifecycle.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const item = (id, family, split) => ({
  id, family, split, text: `synthetic ${id}`, origin: { kind: 'made-up-fixture' },
});

test('family split validation accepts separate train and eval families', () => {
  const result = validateFamilySplit({
    schema: 'book-voice-decider-challenge-v3',
    items: [item('train-a', 'family-a', 'train'), item('train-b', 'family-a', 'train'), item('eval-a', 'family-b', 'eval')],
  });
  assert.deepEqual(result, { train_families: 1, eval_families: 1, items: 3 });
});

test('family split validation refuses a family that crosses train and eval', () => {
  assert.throws(() => validateFamilySplit({
    schema: 'book-voice-decider-challenge-v3',
    items: [item('train-a', 'same-family', 'train'), item('eval-a', 'same-family', 'eval')],
  }), /crosses split boundaries/u);
});

test('family split validation refuses datasets with no held-out eval family', () => {
  assert.throws(() => validateFamilySplit({
    schema: 'book-voice-decider-challenge-v3',
    items: [item('train-a', 'family-a', 'train')],
  }), /separate train and eval families/u);
});

test('family split validation refuses missing source identity fields', () => {
  assert.throws(() => validateFamilySplit({
    schema: 'book-voice-decider-challenge-v3',
    items: [{ id: 'no-family', split: 'train', text: 'synthetic', origin: { kind: 'made-up-fixture' } }],
  }), /missing or duplicate item id/u);
});

const criterion = { id: 'voice', question: 'Does this match the source voice?', primitive: 'one-of',
  reference_context: 'Synthetic reference: clear everyday words.', applies_to: ['paragraph'],
  options: [{ name: 'pass', description: 'The source supports this wording.' }, { name: 'fail', description: 'The source rejects this wording.' }] };
const challenge = () => ({ schema: 'book-voice-decider-challenge-v3', dataset_role: 'synthetic training and held-out source challenge', criteria: [criterion],
  items: [
    { ...item('a', 'source-one', 'train'), block_kind: 'paragraph', checks: { voice: 'pass' }, context: 'PRIVATE LABEL MUST STAY OFF WIRE' },
    { ...item('b', 'source-two', 'eval'), block_kind: 'paragraph', checks: { voice: 'fail' } },
  ] });

test('dataset production uses the maintained projection and keeps eval labels out of training', () => {
  const data = challenge();
  const built = buildTrainingDataset(data, `1f:${'a'.repeat(64)}`);
  assert.equal(built.rows.length, 1);
  assert.equal(built.rows[0].state.target_text, data.items[0].text);
  assert.equal(built.rows[0].gold, 'pass');
  assert.equal(Object.hasOwn(built.rows[0].state, 'gold'), false);
  assert.equal(JSON.stringify(built.rows[0].state).includes('PRIVATE LABEL'), false);
  assert.deepEqual(built.provenance.rows.map(row => row.source_item_id), ['a']);
  assert.deepEqual(built.evaluation.items.map(row => row.id), ['b']);
});

test('dataset production refuses a training label outside its source criterion options', () => {
  const data = challenge(); data.items[0].checks.voice = 'made-up-label';
  assert.throws(() => buildTrainingDataset(data, `1f:${'a'.repeat(64)}`), /invalid gold checks/u);
});

test('dataset production refuses missing source role metadata instead of inventing it', () => {
  const data = challenge(); delete data.dataset_role;
  assert.throws(() => buildTrainingDataset(data, `1f:${'a'.repeat(64)}`), /nonempty dataset_role/u);
});

test('private file reads use exact immutable identities and reject changed bytes', async () => {
  const bytes = Buffer.from('synthetic private DATA');
  const identity = makeHashCodeHexFromBytes(bytes);
  const calls = [];
  const door = { async files(method, input) {
    calls.push({ method, input });
    if (method === 'find_file') return { name: 'made-up.json' };
    return { content: bytes.toString('base64'), encoding: 'base64', byte_length: bytes.length, bytes_returned: bytes.length };
  } };
  assert.deepEqual(await fileBytes(door, identity, 'source_data'), bytes);
  assert.ok(calls.every(call => call.input.name_or_identity === identity));
  await assert.rejects(fileBytes(door, `1f:${'b'.repeat(64)}`, 'source_data'), /do not match/u);
});

test('a classifier-ready manifest must belong to the exact selected model record', () => {
  const where = { type: 'classifier-model', id: 'synthetic-model' };
  const model = { classifier: 'questions-first-decider', weights: { hugging_face: { repo: 'synthetic/model', revision: 'a'.repeat(40) } },
    frame: '{text}', device: 'cpu', lora_targets: ['synthetic_projection'] };
  const ready = { model: where, classifier: model.classifier, identity: `1f:${'a'.repeat(64)}`,
    files: [{ name: 'config.json', bytes: 2, blake3: 'b'.repeat(64) }] };
  assert.equal(requiredModel(model, where, ready, { type: 'classifier-ready', id: 'synthetic-ready' }).ready.identity, ready.identity);
  assert.throws(() => requiredModel(model, where, { ...ready, model: { ...where, id: 'another-model' } }, {}), /this exact model/u);
  assert.throws(() => requiredModel(model, where, { ...ready, files: [{ ...ready.files[0], name: '../escape' }] }, {}), /safe names/u);
});

test('mounted model Files entries must exactly match the ready record by name, BLAKE3 identity and bytes', () => {
  const ready = [
    { name: 'config.json', bytes: 12, blake3: 'a'.repeat(64) },
    { name: 'model-00001.safetensors', bytes: 8192, blake3: 'b'.repeat(64) },
  ];
  const mounted = [
    { name: 'model-00001.safetensors', bytes: 8192, identity: `1f:${'b'.repeat(64)}` },
    { name: 'config.json', bytes: 12, identity: `1f:${'a'.repeat(64)}` },
  ];
  assert.deepEqual(validateModelFiles(mounted, ready), [
    { name: 'config.json', bytes: 12, identity: `1f:${'a'.repeat(64)}` },
    { name: 'model-00001.safetensors', bytes: 8192, identity: `1f:${'b'.repeat(64)}` },
  ]);
  for (const wrong of [
    mounted.slice(1),
    [{ ...mounted[0], identity: `1f:${'c'.repeat(64)}` }, mounted[1]],
    [{ ...mounted[0], bytes: 1 }, mounted[1]],
    [...mounted, mounted[0]],
    [{ ...mounted[0], identity: 'b'.repeat(64) }, mounted[1]],
  ]) assert.throws(() => validateModelFiles(wrong, ready), /model_files/u);
});

const testPython = process.env.WRITING_VOICE_TEST_PYTHON ?? 'python3';
const hasPython = spawnSync(testPython, ['--version'], { encoding: 'utf8' }).status === 0;
const pinnedVersion = spawnSync(PYTHON_PROGRAM, ['--version'], { encoding: 'utf8' });
const hasPinnedPython = pinnedVersion.status === 0 && /^Python 3\.12\.16\s*$/u.test(pinnedVersion.stdout.trim());

test('the declared child program name reaches the pinned Python without a caller override',
  { skip: hasPinnedPython ? false : 'needs the owner-prepared Python 3.12.16 on PATH' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'voice-pinned-launch-'));
    try {
      const script = join(root, 'synthetic.py');
      await writeFile(script, 'import json, sys\nprint(json.dumps(list(sys.version_info[:3])))\n');
      const answer = await runPython(script, [], { dependencies: root, cwd: root });
      assert.deepEqual(JSON.parse(answer.stdout), [3, 12, 16]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('the isolated Python launch imports the staged dependency and preserves the original script argv and cwd',
  { skip: hasPython ? false : 'needs Python for the synthetic launch' }, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'voice-launch-')));
    try {
      const dependencies = join(root, 'libraries');
      await mkdir(dependencies);
      await writeFile(join(dependencies, 'synthetic_voice_dependency.py'), "VALUE = 'synthetic staged library'\n");
      const script = join(root, 'synthetic.py');
      await writeFile(script, `import json, os, sys\nfrom synthetic_voice_dependency import VALUE\nprint(json.dumps({'value': VALUE, 'argv': sys.argv, 'file': __file__, 'cwd': os.getcwd(), 'isolated': bool(sys.flags.isolated), 'startup_bytecode_disabled': bool(sys.flags.dont_write_bytecode)}))\n`);
      const args = ['--mode', 'synthetic mode with spaces', '', '--literal'];
      const answer = await runPython(script, args, { python: testPython, dependencies, cwd: root });
      assert.deepEqual(JSON.parse(answer.stdout), {
        value: 'synthetic staged library', argv: [script, ...args], file: script, cwd: root, isolated: true,
        startup_bytecode_disabled: true,
      });
      await assert.rejects(realpath(join(dependencies, '__pycache__')), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('the Python bootstrap keeps the existing structured refusal contract',
  { skip: hasPython ? false : 'needs Python for the synthetic launch' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'voice-refusal-'));
    try {
      const script = join(root, 'synthetic.py');
      await writeFile(script, "import json, sys\nprint(json.dumps({'error': 'synthetic training refusal'}))\nsys.exit(4)\n");
      await assert.rejects(runPython(script, [], { python: testPython, dependencies: root, cwd: root }), /synthetic training refusal/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('train and score declare the same pinned interpreter and full wheel closure at the bootstrap library root', async () => {
  const rows = JSON.parse(await readFile(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(row => row.payload);
  const selected = ['tool:train-a-writing-voice-adapter', 'tool:score-writing-with-a-voice-adapter']
    .map(id => rows.find(row => row.id === id));
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  for (const row of selected) {
    const python = row.invoke.programs[PYTHON_PROGRAM];
    assert.deepEqual(Object.keys(python.fetch), ['macos-aarch64']);
    assert.equal(python.fetch['macos-aarch64'].version, '3.12.16+20261026');
    assert.equal(python.fetch['macos-aarch64'].executable, `bin/${PYTHON_PROGRAM}`);
    assert.equal(Object.keys(row.invoke.packages).length, 39);
    assert.equal(row.invoke.packages.torch.version, '2.8.0');
    assert.equal(row.invoke.packages.peft.version, '0.21.2');
    assert.equal(row.invoke.packages.transformers.version, '5.19.0');
    const [mount] = row.invoke.files.package_files.filter(item => item.packages);
    assert.deepEqual([...mount.packages].sort(), Object.keys(row.invoke.packages).sort());
    assert.equal(relative(`/opt/${row.maker.replace('maker:', '')}`, mount.at), relative(packageRoot, PYTHON_DEPENDENCIES_DIR));
    for (const pin of Object.values(row.invoke.packages)) {
      assert.equal(pin.archive, 'zip');
      for (const entry of Object.values(pin.fetch)) {
        assert.match(entry.url, /^https:\/\/files\.pythonhosted\.org\/packages\//u);
        assert.match(entry.blake3, /^[0-9a-f]{64}$/u);
        assert.match(entry.checked_against, /^https:\/\/pypi\.org\/pypi\//u);
      }
    }
  }
  assert.deepEqual(selected[0].invoke.packages, selected[1].invoke.packages);
  assert.deepEqual(selected[0].invoke.programs[PYTHON_PROGRAM], selected[1].invoke.programs[PYTHON_PROGRAM]);
});
