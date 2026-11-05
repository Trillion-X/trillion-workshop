// tools/meaning-search/read-data/meaning-search.mjs
//
// Purpose
//   The Workshop seam of meaning-search: it runs the package's own process scripts (do-work/process-scripts, copied
//   from the package unchanged) in the order its actions ran them, on the person's index descriptor and vector set
//   read at run time. `findSimilar` is the package's action:find-similar (the query words embedded by the
//   descriptor's model) and `findSimilarVector` is action:find-similar-vector (a query vector the caller already has,
//   such as the answer of tool:words-as-picture-vector). Both answer what the actions answered, `{ index_id, result,
//   model_id, model_version }`, plus `points_to`: for each address in the result, the file and time span its item
//   names.
//
//   node /opt/records-door/do-work/run-an-export.mjs /opt/meaning-search/read-data/meaning-search.mjs findSimilarVector
//
//   `findSimilarAcross` and `findWordsSaid` below ask the same question of several of the person's descriptors at once
//   (see their headers); they add no ranking of their own.
//
// What is new here, and only this
//   1. The descriptor comes from the person's own records (kind semantic-index-descriptor, read-data/meaning-search.json)
//      through the records door, where the package read it from its record store.
//   2. Its `vector_set` names two of the person's files, read through the files door: `items` (JSON lines, one item a
//      line) and, when the set holds vectors, `vectors` (a 2-D .npy matrix, row i the vector of line i). `points_to`
//      names the item fields that hold the file, start, end and text.
//   3. Each item becomes one upsert of the package's index plan: its address is `<items file>#<line>`, its payload
//      hash is the identity of its line, its revision the identity of its line and vector, and the source snapshot
//      the identity of both files. An item with a vector carries it as the plan's precomputed vector; an item without
//      one is embedded from its text by the package's embedder, as the package's batch plan does.
//   4. The index the package's scripts build from that plan (embedding facts and ANN state) lives only for the run:
//      the vector set is read every run, so the index is ready by construction where the package checked readiness.
//   5. An optional `spread: { per_file, seconds_apart }` in the input keeps the answer from being many neighbouring
//      frames of one recording: the package ranks up to the descriptor's result_limit, then, best first, an item is
//      set aside when its file already has per_file items in the answer, or one less than seconds_apart from it (an
//      item with no start counts once per file); the rest is cut to the asked limit. The package's scores and order
//      are kept; `result.spread` says how many were set aside.
//
// Invariants
//   - Every ranking decision is the package's: preparation, ANN candidates, exact cosine, min_score, limits and order.
//   - Nothing here names a person, a drive, a model or an index; all of it is the descriptor's DATA.
//   - The step files live in a private temporary folder that is removed when the run ends.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { mintCanonicalMultihashOfBytes } from '../do-work/process-scripts/canonical_multihash.mjs';

const settings = JSON.parse(readFileSync(new URL('./meaning-search.json', import.meta.url), 'utf8'));
const SCRIPTS = fileURLToPath(new URL('../do-work/process-scripts/', import.meta.url));
const execute = promisify(execFile);

// One package script, run the way its action ran it; a failed step answers the script's own error line.
async function step(program, script, args, work) {
  try {
    await execute(program === 'node' ? process.execPath : program, [join(SCRIPTS, script), ...args], { cwd: work, maxBuffer: 1 << 30 });
  } catch (error) {
    const said = String(error.stderr || error.message).split('\n').filter(line => /error\b|Error:/.test(line) && !/^\s+at /.test(line));
    throw new Error(said.at(-1)?.trim() || `${script} failed`);
  }
}

const put = (work, name, value) => { writeFileSync(join(work, name), typeof value === 'string' ? value : JSON.stringify(value)); return join(work, name); };
const take = (work, name) => JSON.parse(readFileSync(join(work, name), 'utf8'));

// Every byte of one of the person's files, read through the door a span at a time.
async function readFile(door, name) {
  const parts = [];
  for (let offset = 0; ;) {
    const span = await door.files(settings.files.read, { name_or_identity: name, offset, length: settings.read_bytes });
    const bytes = Buffer.from(span.content ?? '', span.encoding === 'base64' ? 'base64' : 'utf8');
    parts.push(bytes);
    offset += bytes.length;
    if (bytes.length === 0 || offset >= span.byte_length) return Buffer.concat(parts);
  }
}

const half = bits => {
  const sign = bits >> 15 ? -1 : 1;
  const exponent = (bits >> 10) & 31;
  const fraction = bits & 1023;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
};
const READERS = { 2: (view, at) => half(view.getUint16(at, true)), 4: (view, at) => view.getFloat32(at, true), 8: (view, at) => view.getFloat64(at, true) };

// A 2-D little-endian float .npy matrix: row i as its bytes and its numbers.
function npyMatrix(bytes, name) {
  if (bytes.subarray(0, 6).toString('latin1') !== '\x93NUMPY') throw new Error(`${name} is not a .npy file.`);
  const start = bytes[6] === 1 ? 10 : 12;
  const header = bytes.subarray(start, start + (bytes[6] === 1 ? bytes.readUInt16LE(8) : bytes.readUInt32LE(8))).toString('latin1');
  const type = /'descr':\s*'[<|]f([248])'/.exec(header);
  const shape = /'shape':\s*\((\d+),\s*(\d+)\)/.exec(header);
  if (!type || !shape || !/'fortran_order':\s*False/.test(header)) throw new Error(`${name} must hold a 2-D little-endian float matrix in row order.`);
  const width = Number(type[1]);
  const [rows, dims] = [Number(shape[1]), Number(shape[2])];
  const data = bytes.subarray(start + header.length);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const read = READERS[width];
  return {
    rows,
    row: index => ({
      bytes: data.subarray(index * dims * width, (index + 1) * dims * width),
      values: Array.from({ length: dims }, (_, at) => read(view, (index * dims + at) * width)),
    }),
  };
}

// What an item points to: its file, start, end and text, and the other item fields the descriptor's `carry` names (a
// readable name, an id in another app), passed through as the item holds them.
const pointOf = (item, field) => ({
  file: item[field.file] ?? null, start: item[field.start] ?? null, end: item[field.end] ?? null, text: item[field.text] ?? null,
  ...Object.fromEntries((field.carry ?? []).map(name => [name, item[name] ?? null])),
});

// The package's index plan for the person's vector set, and what each address points to.
async function planOf(descriptor, door) {
  const set = descriptor.vector_set;
  if (!set?.items?.file || !set.points_to?.file) {
    throw new Error(`Descriptor ${descriptor.index_id} needs vector_set: { items: { file }, vectors?: { file }, points_to: { file, start?, end?, text? } }.`);
  }
  const itemBytes = await readFile(door, set.items.file);
  const vectorBytes = set.vectors?.file ? await readFile(door, set.vectors.file) : Buffer.alloc(0);
  const lines = itemBytes.toString('utf8').split('\n').filter(line => line.trim());
  const matrix = set.vectors?.file ? npyMatrix(vectorBytes, set.vectors.file) : null;
  if (matrix && matrix.rows !== lines.length) throw new Error(`${set.vectors.file} has ${matrix.rows} vectors and ${set.items.file} has ${lines.length} items; each item needs its vector.`);
  const snapshot = mintCanonicalMultihashOfBytes(Buffer.concat([vectorBytes, itemBytes]));
  const at = new Date().toISOString();
  const field = set.points_to;
  const pointsTo = new Map();
  const upserts = lines.map((line, index) => {
    const item = JSON.parse(line);
    const address = `${set.items.file}#${index}`;
    const lineBytes = Buffer.from(line, 'utf8');
    const vector = matrix?.row(index);
    pointsTo.set(address, pointOf(item, field));
    return {
      index_id: descriptor.index_id, content_address: address, canonical_address: address,
      canonical_revision: mintCanonicalMultihashOfBytes(vector ? Buffer.concat([lineBytes, vector.bytes]) : lineBytes),
      canonical_payload_hash: mintCanonicalMultihashOfBytes(lineBytes), source_snapshot_ref: snapshot, at,
      content_text: String(item[field.text] ?? ''),
      ...(vector ? { content_vector_base64: Buffer.from(JSON.stringify({ vector: vector.values })).toString('base64') } : {}),
    };
  });
  return { plan: { upserts }, pointsTo };
}

// The descriptor rows of this index in the person's records: the package's read_descriptor reply.
async function descriptorReply(door, indexId) {
  const items = [];
  for await (const record of door.list({ type: settings.descriptor_kind })) if (record.value?.index_id === indexId) items.push(record.value);
  return { items };
}

function checkSpread(spread, limit) {
  if (spread === undefined) return;
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1)) throw new Error('limit must be a whole number of at least 1.');
  const ok = spread && typeof spread === 'object' && Number.isInteger(spread.per_file) && spread.per_file >= 1
    && (spread.seconds_apart === undefined || (typeof spread.seconds_apart === 'number' && spread.seconds_apart >= 0));
  if (!ok) throw new Error('spread must be { per_file: a whole number of at least 1, seconds_apart?: a number of at least 0 }.');
}

// Best first, keep an item only while its file has room and it is far enough from the items of that file already kept.
export function spreadItems(items, pointsTo, { per_file: perFile, seconds_apart: apart = 0 }, limit) {
  const kept = [];
  const byFile = new Map();
  let setAside = 0;
  for (const item of items) {
    if (kept.length >= limit) break;
    const { file = null, start = null } = pointsTo.get(item.address) ?? {};
    const mine = byFile.get(file) ?? [];
    const timed = typeof start === 'number';
    const full = mine.length >= (timed ? perFile : 1) || mine.some(other => !timed || typeof other !== 'number');
    if (full || (timed && mine.some(other => Math.abs(other - start) < apart))) {
      setAside += 1;
      continue;
    }
    mine.push(start);
    byFile.set(file, mine);
    kept.push(item);
  }
  return { kept, setAside };
}

// action:index-content-vector and the batch plan for the whole set, then the find actions' preparation, ANN query,
// facts and rank. `query(work, descriptor)` writes embedding.json and vector.json the way each find action did.
async function run(input, door, query) {
  checkSpread(input.spread, input.limit);
  const work = mkdtempSync(join(tmpdir(), 'meaning-search-'));
  try {
    const index = input.index_id;
    const reply = put(work, 'd.json', await descriptorReply(door, index));
    put(work, 'empty.json', { items: [] });
    await step('node', 'prepare-semantic-index-process-input.mjs', ['--index-id', index, '--descriptor-reply-json', reply, '--ann-state-reply-json', join(work, 'empty.json'), '--output-state-json', join(work, 'none.json'), '--output-json', join(work, 'described.json')], work);
    const { descriptor } = take(work, 'described.json');
    const { plan, pointsTo } = await planOf(descriptor, door);
    put(work, 'plan.json', plan);
    put(work, 'descriptor.json', descriptor);
    put(work, 'params.json', descriptor.ann_params ?? {});
    await step('node', 'prepare-semantic-index-process-input.mjs', ['--index-id', index, '--descriptor-reply-json', reply, '--ann-state-reply-json', join(work, 'empty.json'), '--plan-json', join(work, 'plan.json'), '--embedding-request-json', join(work, 'texts.json'), '--output-state-json', join(work, 'none.json'), '--output-json', join(work, 'described.json')], work);
    if (take(work, 'texts.json').items.length) {
      await step('node', 'embed-text-ollama.mjs', ['--request-json', join(work, 'texts.json'), '--output-json', join(work, 'embedded.json'), '--model', descriptor.model_id, '--endpoint', descriptor.model_endpoint], work);
    } else {
      put(work, 'embedded.json', { vectors: {} });
    }
    await step('python3', 'make-embedding-facts-from-command-output.py', ['--plan-json', join(work, 'plan.json'), '--command-output-json', join(work, 'embedded.json'), '--descriptor-json', join(work, 'descriptor.json'), '--output-json', join(work, 'facts.out.json'), '--output-vectors-json', join(work, 'vectors.json')], work);
    await step('node', 'ann-index.mjs', ['--mode', 'apply-plan', '--index-id', index, '--state-json', join(work, 'none.json'), '--plan-json', join(work, 'plan.json'), '--vectors-json', join(work, 'vectors.json'), '--params-json', join(work, 'params.json'), '--output-state-json', join(work, 'built-state.json'), '--output-facts-json', join(work, 'ann-facts.json')], work);
    put(work, 's.json', { items: take(work, 'ann-facts.json').map(row => row.payload) });
    await step('node', 'prepare-semantic-index-process-input.mjs', ['--index-id', index, '--descriptor-reply-json', reply, '--ann-state-reply-json', join(work, 's.json'), '--output-state-json', join(work, 'state.json'), '--output-json', join(work, 'o.json')], work);
    const prepared = take(work, 'o.json').descriptor;
    put(work, 'descriptor.json', prepared);
    put(work, 'params.json', prepared.ann_params ?? {});
    await query(work, prepared);
    await step('node', 'ann-index.mjs', ['--mode', 'query', '--state-json', join(work, 'state.json'), '--vector-json', join(work, 'vector.json'), '--params-json', join(work, 'params.json'), '--output-candidates-json', join(work, 'candidates.out.json')], work);
    const candidates = new Set(take(work, 'candidates.out.json').map(candidate => candidate.subject_ref));
    const property = `${settings.embedding_property}${index}`;
    const facts = take(work, 'facts.out.json').map(row => row.payload)
      .filter(fact => fact.table === settings.attribute_table && fact.property_id === property && candidates.has(fact.subject_id));
    put(work, 'facts.json', facts);
    const { spread, ...asked } = input;
    // With a spread the package ranks as many as the descriptor allows, so there is something left after setting aside.
    put(work, 'input.json', spread ? { ...asked, limit: prepared.result_limit } : asked);
    await step('node', 'nearest-embedding-facts.mjs', ['--embedding-json', join(work, 'embedding.json'), '--input-json', join(work, 'input.json'), '--descriptor-json', join(work, 'descriptor.json'), '--facts-json', join(work, 'facts.json'), '--output-json', join(work, 'nearest.json')], work);
    const result = take(work, 'nearest.json');
    if (spread) {
      const limit = Math.min(Number.isInteger(input.limit) ? input.limit : prepared.result_limit, prepared.result_limit);
      const { kept, setAside } = spreadItems(result.items, pointsTo, spread, limit);
      result.items = kept;
      result.spread = { per_file: spread.per_file, seconds_apart: spread.seconds_apart ?? 0, set_aside: setAside };
    }
    return {
      index_id: index, result, model_id: prepared.model_id, model_version: prepared.model_version,
      points_to: Object.fromEntries(result.items.map(item => [item.address, pointsTo.get(item.address)])),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** action:find-similar: the query words embedded by the descriptor's model, then ranked. */
export async function findSimilar(input, { door }) {
  if (typeof input?.index_id !== 'string' || typeof input.query_text !== 'string' || !input.query_text.trim()) {
    throw new Error('Send index_id (the id of one of your semantic-index-descriptor records) and query_text (the words to look for).');
  }
  return run(input, door, async (work, descriptor) => {
    put(work, 'request.json', input);
    await step('node', 'embed-text-ollama.mjs', ['--request-json', join(work, 'request.json'), '--output-json', join(work, 'embedding.json'), '--model', descriptor.model_id, '--endpoint', descriptor.model_endpoint], work);
    put(work, 'vector.json', take(work, 'embedding.json').vector);
  });
}

/** action:find-similar-vector: a query vector made by the descriptor's model, ranked without embedding. */
export async function findSimilarVector(input, { door }) {
  if (typeof input?.index_id !== 'string' || typeof input.query_vector_base64 !== 'string' || !input.query_vector_base64) {
    throw new Error('Send index_id (the id of one of your semantic-index-descriptor records) and query_vector_base64 (base64 of JSON {"vector": [...]}, made by the model the descriptor names).');
  }
  return run(input, door, work => {
    const embedding = Buffer.from(input.query_vector_base64, 'base64');
    put(work, 'embedding.json', embedding.toString('utf8'));
    put(work, 'vector.json', JSON.parse(embedding.toString('utf8')).vector);
  });
}

const ACROSS = 'Send index_ids: the ids of one or more of your semantic-index-descriptor records.';

// The descriptors' ids a request names, or a refusal.
function indexIds(input) {
  const ids = input?.index_ids;
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error(ACROSS);
  return ids;
}

/**
 * The same query vector over several of the person's descriptors at once, best first across all of them. Each
 * descriptor is ranked by the package exactly as findSimilarVector ranks one; their answers are then merged by score and the optional spread and the limit are applied to the merged list. Scores compare
 * only vectors of one model, so descriptors of different models are refused, never merged.
 */
export async function findSimilarAcross(input, { door }) {
  const ids = indexIds(input);
  checkSpread(input.spread, input.limit);
  const { spread } = input;
  const asked = { ...input };
  delete asked.index_ids;
  delete asked.spread;
  const answers = [];
  for (const id of ids) answers.push(await findSimilarVector({ ...asked, index_id: id }, { door }));
  const models = new Set(answers.map(answer => `${answer.model_id}@${answer.model_version}`));
  if (models.size > 1) throw new Error(`These indexes were made by different models (${[...models].join(', ')}); their scores cannot be compared. Search them one at a time.`);
  const items = answers.flatMap(answer => answer.result.items).sort((a, b) => b.score - a.score);
  const pointsTo = new Map(answers.flatMap(answer => Object.entries(answer.points_to)));
  const limit = Number.isInteger(input.limit) ? input.limit : Math.max(...answers.map(answer => answer.result.items.length), 1);
  const result = { items, considered: answers.reduce((sum, a) => sum + (a.result.considered ?? 0), 0), skipped: answers.reduce((sum, a) => sum + (a.result.skipped ?? 0), 0), min_score: answers[0].result.min_score };
  if (spread) {
    const { kept, setAside } = spreadItems(items, pointsTo, spread, limit);
    result.items = kept;
    result.spread = { per_file: spread.per_file, seconds_apart: spread.seconds_apart ?? 0, set_aside: setAside };
  } else {
    result.items = items.slice(0, limit);
  }
  return {
    index_ids: ids, result, model_id: answers[0].model_id, model_version: answers[0].model_version,
    points_to: Object.fromEntries(result.items.map(item => [item.address, pointsTo.get(item.address)])),
  };
}

const WORD = /[a-z']+/g;

/**
 * The lines of the person's vector sets that say every word of query_text longer than two letters (case ignored), in the
 * order the sets hold them: the words lane of a search, for items whose descriptor names a `text` field. Answers
 * { index_ids, lines: [{ address, file, start, end, text, ...carried }] }, at most `limit` (8 when none is asked).
 */
export async function findWordsSaid(input, { door }) {
  const ids = indexIds(input);
  if (typeof input.query_text !== 'string') throw new Error('Send query_text: the words to look for.');
  if (input.limit !== undefined && !(Number.isInteger(input.limit) && input.limit >= 1)) throw new Error('limit must be a whole number of at least 1.');
  const limit = input.limit ?? 8;
  const words = (input.query_text.toLowerCase().match(WORD) ?? []).filter(word => word.length > 2);
  const lines = [];
  for (const id of ids) {
    const [descriptor] = (await descriptorReply(door, id)).items;
    const set = descriptor?.vector_set;
    if (!set?.items?.file || !set.points_to?.file || !set.points_to.text) throw new Error(`Descriptor ${id} needs vector_set.items.file and points_to: { file, text }.`);
    const rows = (await readFile(door, set.items.file)).toString('utf8').split('\n').filter(line => line.trim());
    for (const [index, line] of rows.entries()) {
      if (!words.length || lines.length >= limit) break;
      const item = JSON.parse(line);
      const said = String(item[set.points_to.text] ?? '').toLowerCase();
      if (words.every(word => said.includes(word))) lines.push({ address: `${set.items.file}#${index}`, ...pointOf(item, set.points_to) });
    }
  }
  return { index_ids: ids, lines };
}
