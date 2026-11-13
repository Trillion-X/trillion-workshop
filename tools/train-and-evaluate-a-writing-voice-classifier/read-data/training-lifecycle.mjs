// Training DATA, its source-bound provenance and model configuration are read by exact record/file identity.
// The runner keeps the three adapter outputs through invoke.outputs; this module never uploads or renames them.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { readWholeFile } from '../../records-door/read-data/whole-file.mjs';
import { requestPlan, validateInput } from './evaluation-integrity.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const TRAINER = join(HERE, '../do-work/train-voice-adapter.py');
const SCORER = join(HERE, '../do-work/score-voice-adapter.py');
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 10_000;
const IDENTITY = /^1f:[0-9a-f]{64}$/u;
const ROW_ADDRESS_FIELDS = ['dataset', 'model', 'ready', 'settings'];
// This path is inside the tool's private run folder. The generic engine keeps each declared file after success.
export const OUTPUT_DIR = join(HERE, '../.training-output/adapter');
export const DATASET_DIR = join(HERE, '../.training-output/dataset');
export const REPORT_DIR = join(HERE, '../.training-output/report');
// invoke.files.account_files stages the source-bound snapshot here inside this private run folder.
export const MODEL_SNAPSHOT_DIR = fileURLToPath(new URL('../model-snapshot/', import.meta.url));
// The row mounts its verified wheels at this fixed root in the same private run folder.
export const PYTHON_DEPENDENCIES_DIR = fileURLToPath(new URL('../python-dependencies/', import.meta.url));
export const PYTHON_PROGRAM = 'python3.12';
const COMMON_DIR = fileURLToPath(new URL('../../fine-tune-a-small-model-on-a-persons-rules/read-data', import.meta.url));
const MODEL_OWNER_DIR = fileURLToPath(new URL('../../answer-questions-about-many-states/do-work', import.meta.url));

export class TrainingRefusal extends Error {}

function address(input, field) {
  const value = input?.[field];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.type !== 'string' || !value.type.trim()
    || typeof value.id !== 'string' || !value.id.trim()) {
    throw new TrainingRefusal(`\`${field}\` must name one exact record as { type, id }`);
  }
  return { type: value.type, id: value.id };
}

function recordValue(row, field) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.schema !== field) {
    throw new TrainingRefusal(`the ${field} record has an unsupported schema`);
  }
  return row;
}

async function readRecord(door, where, label) {
  const value = await door.read(where.type, where.id);
  if (value === null) throw new TrainingRefusal(`the ${label} record ${where.id} is not in this account's records`);
  return value;
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new TrainingRefusal(`the ${label} file is not valid UTF-8 JSON`); }
}

function parseJsonl(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new TrainingRefusal('the training DATA file is not valid UTF-8');
  const rows = [];
  for (const [i, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch { throw new TrainingRefusal(`the training DATA file has invalid JSON on line ${i + 1}`); }
    if (rows.length > MAX_ROWS) throw new TrainingRefusal(`the training DATA file exceeds ${MAX_ROWS} rows`);
  }
  if (!rows.length) throw new TrainingRefusal('the training DATA file has no rows');
  return rows;
}

export function validateFamilySplit(source) {
  if (!source || source.schema !== 'book-voice-decider-challenge-v3' || !Array.isArray(source.items)) {
    throw new TrainingRefusal('the source DATA must be a maintained v3 challenge with source items');
  }
  const ids = new Set();
  const families = new Map();
  let trainFamilies = 0, evalFamilies = 0;
  for (const item of source.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.id !== 'string' || !item.id || ids.has(item.id)
      || typeof item.family !== 'string' || !item.family.trim()
      || !['train', 'eval', 'unlabeled'].includes(item.split)
      || typeof item.text !== 'string' || !item.text.trim()
      || !(item.origin?.kind || item.source_kind)) {
      throw new TrainingRefusal('the source DATA has a missing or duplicate item id, family, split or source kind');
    }
    ids.add(item.id);
    const previous = families.get(item.family);
    if (previous && previous !== item.split) throw new TrainingRefusal(`source family ${item.family} crosses split boundaries`);
    families.set(item.family, item.split);
  }
  for (const split of families.values()) {
    if (split === 'train') trainFamilies += 1;
    if (split === 'eval') evalFamilies += 1;
  }
  if (!trainFamilies || !evalFamilies) throw new TrainingRefusal('source DATA needs separate train and eval families before training');
  return { train_families: trainFamilies, eval_families: evalFamilies, items: source.items.length };
}

function validateTrainRows(rows) {
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || !['book-voice-adapter-training-row-v1', 'book-voice-adapter-training-row-v2'].includes(row.schema)
      || row.split !== 'train' || !row.state || typeof row.state !== 'object'
      || Object.hasOwn(row.state, 'gold') || Object.hasOwn(row.state, 'label')) {
      throw new TrainingRefusal('training DATA must contain only supported train rows, with labels outside state');
    }
    const id = row.training_row_id;
    if (id !== undefined && (typeof id !== 'string' || !id.trim() || seen.has(id))) {
      throw new TrainingRefusal('training DATA row ids must be unique nonempty strings');
    }
    if (id !== undefined) seen.add(id);
  }
}

export function requiredModel(value, addressOfModel, ready, addressOfReady) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TrainingRefusal('the model record must hold the selected classifier configuration');
  if (value.classifier !== 'questions-first-decider') throw new TrainingRefusal('the model row must name the questions-first-decider family');
  const weights = value.weights;
  const frame = value.frame;
  const device = value.device;
  const targets = value.lora_targets;
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)
    || !(typeof weights.folder === 'string' && weights.folder.startsWith('/')
      || typeof weights.hugging_face?.repo === 'string' && weights.hugging_face.repo
        && /^[0-9a-f]{40}$/u.test(weights.hugging_face.revision))) {
    throw new TrainingRefusal('the model row needs its existing weights folder or a pinned Hugging Face commit');
  }
  if (typeof frame !== 'string' || !frame.includes('{text}')) throw new TrainingRefusal('the model row frame must contain {text}');
  if (!['mps', 'cuda', 'cpu'].includes(device)) throw new TrainingRefusal('the model row device must be mps, cuda or cpu');
  if (!Array.isArray(targets) || !targets.length || targets.some(x => typeof x !== 'string' || !x.trim())
    || new Set(targets).size !== targets.length) throw new TrainingRefusal('the model row needs unique LoRA target module names');
  if (!ready || ready.classifier !== value.classifier || ready.model?.type !== addressOfModel.type
    || ready.model?.id !== addressOfModel.id || !IDENTITY.test(ready.identity)
    || !Array.isArray(ready.files) || !ready.files.length) {
    throw new TrainingRefusal('the ready record must bind this exact model to its prepared file identities');
  }
  const names = new Set();
  for (const file of ready.files) {
    if (!file || typeof file.name !== 'string' || !file.name || file.name.startsWith('/')
      || file.name.split('/').some(part => !part || part === '.' || part === '..') || file.name.includes('\\')
      || names.has(file.name) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || !/^[0-9a-f]{64}$/u.test(file.blake3)) {
      throw new TrainingRefusal('the ready file manifest must contain unique safe names, sizes and BLAKE3 hashes');
    }
    names.add(file.name);
  }
  return { ...value, model_record: addressOfModel, ready_record: addressOfReady,
    ready: { identity: ready.identity, files: ready.files } };
}

/** The returned Files tree and ready record must describe exactly the same immutable snapshot. */
export function validateModelFiles(files, readyFiles) {
  if (!Array.isArray(readyFiles) || !Array.isArray(files) || files.length !== readyFiles.length || files.length === 0) {
    throw new TrainingRefusal('model_files must include every file from the selected classifier-ready record');
  }
  const exact = readyFiles.map(file => ({ name: file.name, identity: `1f:${file.blake3}`, bytes: file.bytes }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const seen = new Set();
  const supplied = files.map(file => {
    if (!file || typeof file !== 'object' || Array.isArray(file)
      || Object.keys(file).sort().join(',') !== 'bytes,identity,name'
      || typeof file.name !== 'string' || !file.name || file.name.includes('/') || file.name.includes('\\')
      || !IDENTITY.test(file.identity) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || seen.has(file.name)) {
      throw new TrainingRefusal('model_files needs unique {name, identity, bytes} entries with exact file identities');
    }
    seen.add(file.name);
    return { name: file.name, identity: file.identity, bytes: file.bytes };
  }).sort((a, b) => a.name.localeCompare(b.name));
  if (JSON.stringify(supplied) !== JSON.stringify(exact)) {
    throw new TrainingRefusal('model_files do not match every file in the selected classifier-ready record');
  }
  return exact;
}

function mountedModel(model, ready, modelFiles) {
  validateModelFiles(modelFiles, ready.files);
  // The physical path varies with the run folder; classifier semantics remain sourced from the exact model row.
  return { ...model, weights: { folder: MODEL_SNAPSHOT_DIR } };
}

function trainingSettings(settings) {
  const value = recordValue(settings, 'book-voice-adapter-training-settings-v1');
  const config = value.train;
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TrainingRefusal('the settings row needs a train object');
  const allowed = new Set(['rank', 'epochs', 'lr', 'batch', 'max_steps', 'seed', 'lora_dropout']);
  if (Object.keys(config).some(key => !allowed.has(key))) throw new TrainingRefusal('the settings row train object has unsupported fields');
  const positive = ['rank', 'epochs', 'lr', 'batch'];
  for (const key of positive) {
    if (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] <= 0) {
      throw new TrainingRefusal(`the settings row train.${key} must be a positive number`);
    }
  }
  if (!Number.isInteger(config.rank) || !Number.isInteger(config.batch)) throw new TrainingRefusal('train.rank and train.batch must be whole numbers');
  if (config.max_steps !== undefined && (!Number.isInteger(config.max_steps) || config.max_steps < 0)) throw new TrainingRefusal('train.max_steps must be a nonnegative whole number');
  if (config.seed !== undefined && (!Number.isInteger(config.seed) || config.seed < 0)) throw new TrainingRefusal('train.seed must be a nonnegative whole number');
  if (config.lora_dropout !== undefined && (typeof config.lora_dropout !== 'number' || !Number.isFinite(config.lora_dropout) || config.lora_dropout < 0 || config.lora_dropout >= 1)) {
    throw new TrainingRefusal('train.lora_dropout must be in the range [0, 1)');
  }
  return config;
}

export async function fileBytes(door, identity, label, mostBytes = MAX_FILE_BYTES) {
  if (typeof identity !== 'string' || !IDENTITY.test(identity)) throw new TrainingRefusal(`the dataset row ${label} must name a BLAKE3 file identity`);
  const { bytes } = await readWholeFile(door, identity, { readBytes: 16 * 1024, mostBytes });
  if (!bytes) throw new TrainingRefusal(`the ${label} file exceeds the ${mostBytes} byte limit`);
  if (digest(bytes) !== identity) throw new TrainingRefusal(`the ${label} bytes do not match the dataset record identity`);
  return bytes;
}

const digest = bytes => makeHashCodeHexFromBytes(bytes);

export function buildTrainingDataset(source, sourceIdentity) {
  if (!IDENTITY.test(sourceIdentity)) throw new TrainingRefusal('the source challenge needs an exact BLAKE3 identity');
  const split = validateFamilySplit(source);
  validateInput(source, { mode: 'training' });
  const rows = [], bindings = [];
  for (const item of source.items.filter(item => item.split === 'train')) {
    const plan = requestPlan(source, item);
    if (plan.chunk_requests?.length) throw new TrainingRefusal('section chunk training needs an explicit source-bound training projection');
    for (const [criterionId, request] of Object.entries(plan.asking)) {
      const gold = item.checks?.[criterionId];
      if (gold === undefined) continue;
      if (request.shape.kind !== 'one-of') throw new TrainingRefusal('adapter training needs described one-of options');
      const options = request.shape.options.map(option => typeof option === 'string' ? { name: option, description: '' } : option);
      if (options.some(option => !option.name || !option.description?.trim()) || !options.some(option => option.name === gold)) {
        throw new TrainingRefusal('each training label must name a described option in its source criterion');
      }
      const state = JSON.parse(plan.content);
      const rowId = digest(Buffer.from(JSON.stringify([item.id, criterionId]), 'utf8'));
      rows.push({ schema: 'book-voice-adapter-training-row-v2', training_row_id: rowId, split: 'train', state,
        question: request.question, options: Object.fromEntries(options.map(option => [option.name, option.description])), gold });
      bindings.push({ training_row_id: rowId, source_item_id: item.id, criterion_id: criterionId,
        family: item.family, text: item.text, state, question: request.question, options, gold_check: gold });
    }
  }
  if (!rows.length) throw new TrainingRefusal('the challenge has no explicitly labelled training requests');
  return { rows, split, provenance: { schema: 'book-voice-training-provenance-v3', source_dataset: sourceIdentity,
    source_dataset_blake3: sourceIdentity.slice(3), request_projection_policy: 'maintained-requestPlan-multi-criterion-per-row-v1', rows: bindings },
  evaluation: { ...source, items: source.items.filter(item => item.split === 'eval') } };
}

// Produces the dataset address consumed by training. Publication uses the same generic output/record handling as
// the adapter, so retrying output persistence never re-derives a different dataset or writes a second account copy.
export async function prepareVoiceTrainingData(input, { door } = {}) {
  const sourceBytes = await fileBytes(door, input?.source_data, 'source_data');
  const source = parseJson(sourceBytes, 'source DATA');
  const built = buildTrainingDataset(source, input.source_data);
  const content = {
    training_data: { name: 'train.jsonl', bytes: Buffer.from(built.rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8') },
    provenance: { name: 'provenance.json', bytes: Buffer.from(JSON.stringify(built.provenance) + '\n', 'utf8') },
    source_data: { name: 'source.json', bytes: sourceBytes },
    evaluation_data: { name: 'evaluation.json', bytes: Buffer.from(JSON.stringify(built.evaluation) + '\n', 'utf8') },
  };
  await mkdir(DATASET_DIR, { recursive: true, mode: 0o700 });
  const files = {};
  for (const [key, file] of Object.entries(content)) {
    await writePrivate(join(DATASET_DIR, file.name), file.bytes);
    files[key] = digest(file.bytes);
  }
  const id = `record:classifier-training-dataset:${digest(sourceBytes).slice(3)}`;
  return { kept_dataset: { type: 'record:classifier-training-dataset', id,
    value: { schema: 'book-voice-adapter-dataset-ref-v1', ...files, source_families: built.split,
      training_rows: built.rows.length, evaluation_items: built.evaluation.items.length } },
  identities: files };
}

function writePrivate(path, bytes) { return writeFile(path, bytes, { mode: 0o600, flag: 'wx' }); }

// The pinned archive keeps python3.12 as a regular file; its python3 symlink is not unpacked by the program owner.
// -I ignores ambient Python settings; -B disables bytecode writes from interpreter startup, before the script runs.
// Only the row's staged library root is added before the original script runs.
const PYTHON_BOOTSTRAP = "import runpy, sys; dependencies, script, *args = sys.argv[1:]; sys.path.insert(0, dependencies); sys.argv = [script, *args]; runpy.run_path(script, run_name='__main__')";

export function runPython(script, args, { python = PYTHON_PROGRAM, dependencies = PYTHON_DEPENDENCIES_DIR, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', '-B', '-c', PYTHON_BOOTSTRAP, dependencies, script, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', code => {
      const out = Buffer.concat(stdout).toString('utf8');
      if (code !== 0) {
        const last = out.trim().split(/\r?\n/u).at(-1);
        let reason = 'the local trainer stopped before it completed';
        try { const parsed = JSON.parse(last); if (typeof parsed.error === 'string') reason = parsed.error; } catch {}
        reject(new TrainingRefusal(reason));
      } else {
        resolve({ stdout: out, stderr_bytes: Buffer.concat(stderr).length });
      }
    });
  });
}

// Entry used by the computer run. Inputs contain only record/file addresses. Source text and gold labels stay in
// process-private temporary files; stdout contains only hashes, identities and model metadata.
export async function trainVoiceAdapter(input, { door, python = PYTHON_PROGRAM, workspace = tmpdir() } = {}) {
  for (const field of ROW_ADDRESS_FIELDS) address(input, field);
  if (!door || typeof door.read !== 'function') throw new TrainingRefusal('the Records door is unavailable');
  const where = Object.fromEntries(ROW_ADDRESS_FIELDS.map(field => [field, address(input, field)]));
  const dataset = recordValue(await readRecord(door, where.dataset, 'dataset'), 'book-voice-adapter-dataset-ref-v1');
  for (const name of ['training_data', 'provenance', 'source_data']) {
    if (input.dataset[name] !== dataset[name]) throw new TrainingRefusal(`dataset.${name} differs from the selected dataset record`);
  }
  const selectedModel = requiredModel(await readRecord(door, where.model, 'model'), where.model,
    await readRecord(door, where.ready, 'ready'), where.ready);
  const model = mountedModel(selectedModel, selectedModel.ready, input.model_files);
  const settings = trainingSettings(await readRecord(door, where.settings, 'settings'));

  const [trainBytes, provenanceBytes, sourceBytes] = await Promise.all([
    fileBytes(door, dataset.training_data, 'training_data'),
    fileBytes(door, dataset.provenance, 'provenance'),
    fileBytes(door, dataset.source_data, 'source_data'),
  ]);
  const rows = parseJsonl(trainBytes);
  validateTrainRows(rows);
  const provenance = parseJson(provenanceBytes, 'provenance');
  const source = parseJson(sourceBytes, 'source DATA');
  const split = validateFamilySplit(source);
  if (!provenance || !['book-voice-training-provenance-v2', 'book-voice-training-provenance-v3'].includes(provenance.schema)) {
    throw new TrainingRefusal('the provenance file needs a supported source-bound manifest');
  }

  const root = await mkdtemp(join(workspace, 'voice-adapter-'));
  try {
    const dataPath = join(root, 'train.jsonl');
    const provenancePath = join(root, 'provenance.json');
    const sourcePath = join(root, 'source.json');
    const modelPath = join(root, 'model.json');
    const outputPath = OUTPUT_DIR;
    const sourceHash = digest(sourceBytes);
    await Promise.all([
      writePrivate(dataPath, trainBytes),
      writePrivate(sourcePath, sourceBytes),
      writePrivate(provenancePath, provenanceBytes),
      writePrivate(modelPath, Buffer.from(`${JSON.stringify({
        model: { classifier: model.classifier, weights: model.weights }, ready: model.ready,
        frame: model.frame, device: model.device, lora_targets: model.lora_targets,
        model_record: where.model, ready_record: where.ready,
        dataset_record: where.dataset, training_data_identity: dataset.training_data,
        provenance_identity: dataset.provenance, source_data_identity: dataset.source_data,
      })}\n`, 'utf8')),
    ]);
    const args = [
      '--common-dir', COMMON_DIR,
      '--model-owner-dir', MODEL_OWNER_DIR,
      '--data', dataPath, '--provenance', provenancePath, '--source-data', sourcePath, '--out', outputPath,
      '--model-config', modelPath,
      '--rank', String(settings.rank), '--epochs', String(settings.epochs), '--lr', String(settings.lr), '--batch', String(settings.batch),
    ];
    if (settings.max_steps !== undefined) args.push('--max-steps', String(settings.max_steps));
    if (settings.seed !== undefined) args.push('--seed', String(settings.seed));
    if (settings.lora_dropout !== undefined) args.push('--lora-dropout', String(settings.lora_dropout));
    await runPython(TRAINER, args, { python, cwd: root });
    const artifacts = {};
    for (const [name, filename, mediaType] of [
      ['weights', 'adapter_model.safetensors', 'application/octet-stream'],
      ['config', 'adapter_config.json', 'application/json'],
      ['receipt', 'train-info.json', 'application/json'],
    ]) {
      const bytes = await readFile(join(outputPath, filename));
      artifacts[name] = { identity: digest(bytes), bytes: bytes.byteLength, media_type: mediaType };
    }
    const manifestHash = digest(Buffer.from(JSON.stringify({ dataset: where.dataset, model: where.model, settings: where.settings, artifacts }), 'utf8'));
    const manifestId = `record:classifier-adapter:${manifestHash.slice(3)}`;
    return {
      kept_model: {
        id: manifestId,
        type: 'record:classifier-adapter',
        value: {
          schema: 'book-voice-classifier-adapter-v1',
          dataset: where.dataset,
          training_data_identity: dataset.training_data,
          provenance_identity: dataset.provenance,
          source_data_identity: dataset.source_data,
          source_dataset_blake3: sourceHash,
          source_families: split,
          base_model: where.model,
          settings: where.settings,
          artifacts,
        },
      },
      artifacts,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function scoreVoiceAdapter(input, { door, python = PYTHON_PROGRAM, workspace = tmpdir() } = {}) {
  const where = Object.fromEntries(['adapter', 'model', 'ready'].map(name => [name, address(input, name)]));
  const adapter = recordValue(await readRecord(door, where.adapter, 'adapter'), 'book-voice-classifier-adapter-v1');
  if (adapter.base_model?.type !== where.model.type || adapter.base_model?.id !== where.model.id) {
    throw new TrainingRefusal('the adapter was trained from another model record');
  }
  const selectedModel = requiredModel(await readRecord(door, where.model, 'model'), where.model,
    await readRecord(door, where.ready, 'ready'), where.ready);
  const model = mountedModel(selectedModel, selectedModel.ready, input.model_files);
  const expected = { weights: adapter.artifacts?.weights?.identity, config: adapter.artifacts?.config?.identity,
    receipt: adapter.artifacts?.receipt?.identity, source_data: adapter.source_data_identity, provenance: adapter.provenance_identity };
  for (const [name, identity] of Object.entries(expected)) {
    if (input.adapter[name] !== identity) throw new TrainingRefusal(`adapter.${name} differs from the selected adapter record`);
  }
  if (typeof input.dataset_role !== 'string' || !input.dataset_role.trim()) throw new TrainingRefusal('scoring needs an explicit dataset_role');
  if (input.batch !== undefined && (!Number.isSafeInteger(input.batch) || input.batch < 1)) throw new TrainingRefusal('scoring batch must be a positive whole number');
  const dataBytes = await fileBytes(door, input.data, 'evaluation_data');
  const source = parseJson(dataBytes, 'evaluation DATA');
  validateInput(source, { mode: input.mode === 'unlabeled' ? 'unlabeled' : 'scoring-evaluation' });
  const root = await mkdtemp(join(workspace, 'voice-score-'));
  try {
    const adapterDir = join(root, 'adapter');
    await mkdir(adapterDir, { mode: 0o700 });
    const paths = { weights: join(adapterDir, 'adapter_model.safetensors'), config: join(adapterDir, 'adapter_config.json'),
      receipt: join(adapterDir, 'train-info.json'), source_data: join(root, 'training-source.json'), provenance: join(root, 'training-provenance.json') };
    for (const [name, identity] of Object.entries(expected)) await writePrivate(paths[name], await fileBytes(door, identity, name,
      name === 'weights' ? 2 * 1024 * 1024 * 1024 : MAX_FILE_BYTES));
    const dataPath = join(root, 'evaluation.json'), configPath = join(root, 'model.json');
    await writePrivate(dataPath, dataBytes);
    await writePrivate(configPath, Buffer.from(JSON.stringify({ model: { classifier: model.classifier, weights: model.weights }, ready: model.ready,
      frame: model.frame, device: model.device, lora_targets: model.lora_targets, model_record: where.model, ready_record: where.ready }) + '\n'));
    await mkdir(REPORT_DIR, { recursive: true, mode: 0o700 });
    const reportPath = join(REPORT_DIR, 'report.json');
    const args = ['--common-dir', COMMON_DIR, '--model-owner-dir', MODEL_OWNER_DIR, '--model-config', configPath,
      '--data', dataPath, '--adapter', adapterDir, '--out', reportPath, '--dataset-role', input.dataset_role, '--mode', input.mode ?? 'evaluation',
      '--training-source-data', paths.source_data, '--training-source-data-blake3', expected.source_data.slice(3),
      '--training-provenance', paths.provenance, '--training-provenance-blake3', expected.provenance.slice(3)];
    if (input.batch !== undefined) args.push('--batch', String(input.batch));
    await runPython(SCORER, args, { python, cwd: root });
    const bytes = await readFile(reportPath);
    const report = parseJson(bytes, 'scoring report');
    return { report_identity: digest(bytes), adapter: where.adapter, data_identity: input.data,
      summary: report.summary, qualification: 'diagnostic evaluation; inspect held-out evidence before admission' };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
