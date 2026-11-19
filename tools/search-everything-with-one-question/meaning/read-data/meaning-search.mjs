// tools/search-everything-with-one-question/meaning/read-data/meaning-search.mjs
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
//   node tools/records-door/do-work/run-an-export.mjs tools/search-everything-with-one-question/meaning/read-data/meaning-search.mjs findSimilarVector
//
//   `findSimilarAcross` and `findWordsSaid` below ask the same question of several of the person's descriptors at once
//   (see their headers); they add no ranking of their own.
//
// What is new here, and only this
//   1. The descriptor is one of the records the caller hands in (kind semantic-index-descriptor, read-data/meaning-search.json);
//      the caller read it from the person's own store, in its own language, and this seam reads no store.
//   2. Its `vector_set` names two of the person's files, handed in with the run: `items` (JSON lines, one item a
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
import { rankRows } from '../do-work/process-scripts/nearest-embedding-facts.mjs';
import { pyDumps } from '../do-work/process-scripts/pyjson.mjs';

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

// Every byte of one of the person's files, handed in with the run, read a span at a time.
async function readFile(given, name) {
  const parts = [];
  for (let offset = 0; ;) {
    const span = given.readSpan(name, offset, settings.read_bytes);
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

// Bound every vector-bearing process input, not just its writer: the preparation and ANN
// scripts also parse their JSON inputs as one string. Keep mutations in source order so
// applying the batches to one ANN state gives the same buckets and candidate ordering.
function* planBatches(upserts) {
  const limit = settings.index_batch_bytes;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('index_batch_bytes must be a positive integer.');
  let batch = [];
  let bytes = Buffer.byteLength('{"upserts":[]}');
  for (const upsert of upserts) {
    const size = Buffer.byteLength(JSON.stringify(upsert));
    if (batch.length && bytes + 1 + size > limit) {
      yield { upserts: batch };
      batch = [];
      bytes = Buffer.byteLength('{"upserts":[]}');
    }
    batch.push(upsert);
    bytes += size + (batch.length > 1 ? 1 : 0);
  }
  // An empty set still runs the package's validation and empty-state behavior.
  yield { upserts: batch };
}

// The same canonical rows feed bounded index plans or exact search. Vectors
// stay in their .npy bytes until one row is read; exact search never encodes them
// as a whole-index JSON plan.
async function vectorRowsOf(descriptor, given) {
  const set = descriptor.vector_set;
  if (!set?.items?.file || !set.points_to?.file) {
    throw new Error(`Descriptor ${descriptor.index_id} needs vector_set: { items: { file }, vectors?: { file }, points_to: { file, start?, end?, text? } }.`);
  }
  const itemBytes = await readFile(given, set.items.file);
  const vectorBytes = set.vectors?.file ? await readFile(given, set.vectors.file) : Buffer.alloc(0);
  const lines = itemBytes.toString('utf8').split('\n').filter(line => line.trim());
  const matrix = set.vectors?.file ? npyMatrix(vectorBytes, set.vectors.file) : null;
  if (matrix && matrix.rows !== lines.length) throw new Error(`${set.vectors.file} has ${matrix.rows} vectors and ${set.items.file} has ${lines.length} items; each item needs its vector.`);
  const snapshot = mintCanonicalMultihashOfBytes(Buffer.concat([vectorBytes, itemBytes]));
  const at = new Date().toISOString();
  const field = set.points_to;
  const pointsTo = new Map();
  function* rows() {
    for (const [index, line] of lines.entries()) {
      const item = JSON.parse(line);
      const address = `${set.items.file}#${index}`;
      const lineBytes = Buffer.from(line, 'utf8');
      const vector = matrix?.row(index);
      pointsTo.set(address, pointOf(item, field));
      const mutation = {
        index_id: descriptor.index_id, content_address: address, canonical_address: address,
        canonical_revision: mintCanonicalMultihashOfBytes(vector ? Buffer.concat([lineBytes, vector.bytes]) : lineBytes),
        canonical_payload_hash: mintCanonicalMultihashOfBytes(lineBytes), source_snapshot_ref: snapshot, at,
        content_text: String(item[field.text] ?? ''),
      };
      yield { mutation, vector: vector?.values };
    }
  }
  return { rows: rows(), pointsTo };
}

async function planOf(descriptor, given) {
  const { rows, pointsTo } = await vectorRowsOf(descriptor, given);
  function* upserts() {
    for (const { mutation, vector } of rows) yield {
      ...mutation,
      ...(vector ? { content_vector_base64: Buffer.from(JSON.stringify({ vector })).toString('base64') } : {}),
    };
  }
  return { plans: planBatches(upserts()), pointsTo };
}

// The descriptor rows of this index in the person's records: the package's read_descriptor reply.
async function descriptorReply(given, indexId) {
  const items = [];
  for (const record of given.recordsOf(settings.kinds.semantic_index_descriptor)) if (record.value?.index_id === indexId) items.push(record.value);
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
function searchAnswer(input, index, descriptor, result, pointsTo) {
  if (input.spread) {
    const limit = Math.min(Number.isInteger(input.limit) ? input.limit : descriptor.result_limit, descriptor.result_limit);
    const { kept, setAside } = spreadItems(result.items, pointsTo, input.spread, limit);
    result.items = kept;
    result.spread = { per_file: input.spread.per_file, seconds_apart: input.spread.seconds_apart ?? 0, set_aside: setAside };
  }
  return {
    index_id: index, result, model_id: descriptor.model_id, model_version: descriptor.model_version,
    points_to: Object.fromEntries(result.items.map(item => [item.address, pointsTo.get(item.address)])),
  };
}

function rankedResult(embedding, input, descriptor, rows, representationOf, collect) {
  const { spread, ...asked } = input;
  const actionInput = spread ? { ...asked, limit: descriptor.result_limit } : asked;
  const ranked = rankRows({ embedding, input: actionInput, descriptor, rows, ...(representationOf ? { representationOf } : {}) });
  // The aggregate collector receives qualified canonical metadata, not vectors.
  // Preserve the ranker's six-decimal scores without serializing its full pool.
  if (collect) collect(ranked.candidates.map(item => ({ ...item, score: item.score.value })));
  // The seam consumes the same JSON numbers as the existing command consumer.
  return JSON.parse(pyDumps(ranked.result, { ensureAscii: true }));
}

async function run(input, given, query, onExactCandidates) {
  checkSpread(input.spread, input.limit);
  const work = mkdtempSync(join(tmpdir(), 'meaning-search-'));
  try {
    const index = input.index_id;
    const reply = put(work, 'd.json', await descriptorReply(given, index));
    put(work, 'empty.json', { items: [] });
    await step('node', 'prepare-semantic-index-process-input.mjs', ['--index-id', index, '--descriptor-reply-json', reply, '--ann-state-reply-json', join(work, 'empty.json'), '--output-state-json', join(work, 'none.json'), '--output-json', join(work, 'described.json')], work);
    const { descriptor } = take(work, 'described.json');
    const mode = descriptor.search_mode ?? 'approximate';
    if (!['approximate', 'exact'].includes(mode)) throw new Error('Descriptor search_mode must be exact or approximate.');
    const collector = pointsTo => onExactCandidates ? items => onExactCandidates({ items, pointsTo, resultLimit: descriptor.result_limit }) : undefined;
    if (mode === 'exact' && descriptor.vector_set?.vectors?.file) {
      const { rows, pointsTo } = await vectorRowsOf(descriptor, given);
      function* representations() {
        for (const { mutation, vector } of rows) yield { ...mutation, subject_id: mutation.content_address, vector };
      }
      await query(work, descriptor);
      const result = rankedResult(take(work, 'embedding.json'), input, descriptor, representations(), row => row, collector(pointsTo));
      return searchAnswer(input, index, descriptor, result, pointsTo);
    }
    const { plans, pointsTo } = await planOf(descriptor, given);
    put(work, 'descriptor.json', descriptor);
    put(work, 'params.json', descriptor.ann_params ?? {});
    const factBatches = [];
    const indexBatches = [];
    for (const plan of plans) {
      const planPath = put(work, `plan-${indexBatches.length}.json`, plan);
      const vectorsPath = join(work, `vectors-${indexBatches.length}.json`);
      await step('node', 'prepare-semantic-index-process-input.mjs', ['--index-id', index, '--descriptor-reply-json', reply, '--ann-state-reply-json', join(work, 'empty.json'), '--plan-json', planPath, '--embedding-request-json', join(work, 'texts.json'), '--output-state-json', join(work, 'none.json'), '--output-json', join(work, 'described.json')], work);
      if (take(work, 'texts.json').items.length) {
        await step('node', 'embed-text-ollama.mjs', ['--request-json', join(work, 'texts.json'), '--output-json', join(work, 'embedded.json'), '--model', descriptor.model_id, '--endpoint', descriptor.model_endpoint], work);
      } else {
        put(work, 'embedded.json', { vectors: {} });
      }
      const facts = `facts-${factBatches.length}.json`;
      await step('python3', 'make-embedding-facts-from-command-output.py', ['--plan-json', planPath, '--command-output-json', join(work, 'embedded.json'), '--descriptor-json', join(work, 'descriptor.json'), '--output-json', join(work, facts), '--output-vectors-json', vectorsPath], work);
      factBatches.push(facts);
      indexBatches.push({ plan_json: planPath, vectors_json: vectorsPath });
    }
    if (mode === 'exact') {
      function* facts() {
        for (const name of factBatches) for (const row of take(work, name)) {
          const fact = row.payload;
          if (fact.table === settings.attribute_table && fact.property_id === `${settings.embedding_property}${index}`) yield fact;
        }
      }
      await query(work, descriptor);
      const result = rankedResult(take(work, 'embedding.json'), input, descriptor, facts(), undefined, collector(pointsTo));
      return searchAnswer(input, index, descriptor, result, pointsTo);
    }
    put(work, 'batches.json', { batches: indexBatches });
    await step('node', 'ann-index.mjs', ['--mode', 'apply-batches', '--index-id', index, '--state-json', join(work, 'none.json'), '--plan-json', join(work, 'batches.json'), '--params-json', join(work, 'params.json'), '--output-state-json', join(work, 'built-state.json'), '--output-facts-json', join(work, 'ann-facts.json')], work);
    put(work, 's.json', { items: take(work, 'ann-facts.json').map(row => row.payload) });
    await step('node', 'prepare-semantic-index-process-input.mjs', ['--index-id', index, '--descriptor-reply-json', reply, '--ann-state-reply-json', join(work, 's.json'), '--output-state-json', join(work, 'state.json'), '--output-json', join(work, 'o.json')], work);
    const prepared = take(work, 'o.json').descriptor;
    put(work, 'descriptor.json', prepared);
    put(work, 'params.json', prepared.ann_params ?? {});
    await query(work, prepared);
    await step('node', 'ann-index.mjs', ['--mode', 'query', '--state-json', join(work, 'state.json'), '--vector-json', join(work, 'vector.json'), '--params-json', join(work, 'params.json'), '--output-candidates-json', join(work, 'candidates.out.json')], work);
    const candidates = new Set(take(work, 'candidates.out.json').map(candidate => candidate.subject_ref));
    const property = `${settings.embedding_property}${index}`;
    const facts = [];
    for (const name of factBatches) {
      for (const row of take(work, name)) {
        const fact = row.payload;
        if (fact.table === settings.attribute_table && fact.property_id === property && candidates.has(fact.subject_id)) facts.push(fact);
      }
    }
    put(work, 'facts.json', facts);
    const { spread, ...asked } = input;
    // With a spread the package ranks as many as the descriptor allows, so there is something left after setting aside.
    put(work, 'input.json', spread ? { ...asked, limit: prepared.result_limit } : asked);
    await step('node', 'nearest-embedding-facts.mjs', ['--embedding-json', join(work, 'embedding.json'), '--input-json', join(work, 'input.json'), '--descriptor-json', join(work, 'descriptor.json'), '--facts-json', join(work, 'facts.json'), '--output-json', join(work, 'nearest.json')], work);
    const result = take(work, 'nearest.json');
    return searchAnswer(input, index, prepared, result, pointsTo);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** action:find-similar: the query words embedded by the descriptor's model, then ranked. */
export async function findSimilar(input, { given, onExactCandidates }) {
  if (typeof input?.index_id !== 'string' || typeof input.query_text !== 'string' || !input.query_text.trim()) {
    throw new Error('Send index_id (the id of one of your semantic-index-descriptor records) and query_text (the words to look for).');
  }
  return run(input, given, async (work, descriptor) => {
    put(work, 'request.json', input);
    await step('node', 'embed-text-ollama.mjs', ['--request-json', join(work, 'request.json'), '--output-json', join(work, 'embedding.json'), '--model', descriptor.model_id, '--endpoint', descriptor.model_endpoint], work);
    put(work, 'vector.json', take(work, 'embedding.json').vector);
  }, onExactCandidates);
}

/** action:find-similar-vector: a query vector made by the descriptor's model, ranked without embedding. */
export async function findSimilarVector(input, { given, onExactCandidates }) {
  if (typeof input?.index_id !== 'string' || typeof input.query_vector_base64 !== 'string' || !input.query_vector_base64) {
    throw new Error('Send index_id (the id of one of your semantic-index-descriptor records) and query_vector_base64 (base64 of JSON {"vector": [...]}, made by the model the descriptor names).');
  }
  return run(input, given, work => {
    const embedding = Buffer.from(input.query_vector_base64, 'base64');
    put(work, 'embedding.json', embedding.toString('utf8'));
    put(work, 'vector.json', JSON.parse(embedding.toString('utf8')).vector);
  }, onExactCandidates);
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
 * descriptor uses the package's scorer. Exact mode collects its full qualified pool before its direct result cap;
 * approximate mode retains its existing pool. Their candidates are merged by score, then spread and the final
 * aggregate limit apply. Scores compare
 * only vectors of one model, so descriptors of different models are refused, never merged.
 */
export async function findSimilarAcross(input, { given }) {
  const ids = indexIds(input);
  checkSpread(input.spread, input.limit);
  const { spread } = input;
  const asked = { ...input };
  delete asked.index_ids;
  delete asked.spread;
  // Spread is applied after merging: use each descriptor's existing result_limit
  // so clustered top hits do not hide distinct files before the final limit.
  if (spread) delete asked.limit;
  const answers = [];
  const exactPools = [];
  for (const id of ids) {
    let pool;
    answers.push(await findSimilarVector({ ...asked, index_id: id }, { given, onExactCandidates: value => { pool = value; } }));
    exactPools.push(pool);
  }
  const models = new Set(answers.map(answer => `${answer.model_id}@${answer.model_version}`));
  if (models.size > 1) throw new Error(`These indexes were made by different models (${[...models].join(', ')}); their scores cannot be compared. Search them one at a time.`);
  // Exact mode supplies the full qualified pool before the direct-search cap;
  // approximate mode keeps its existing pool. Limit the aggregate only after
  // merging and spreading. The descriptor cap is still its default result size.
  const items = answers.flatMap((answer, at) => exactPools[at]?.items ?? answer.result.items).sort((a, b) => b.score - a.score);
  const pointsTo = new Map(answers.flatMap((answer, at) => exactPools[at]
    ? exactPools[at].items.map(item => [item.address, exactPools[at].pointsTo.get(item.address)])
    : Object.entries(answer.points_to)));
  const limit = Number.isInteger(input.limit) ? input.limit : Math.max(...answers.map((answer, at) => exactPools[at]?.resultLimit ?? answer.result.items.length), 1);
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
export async function findWordsSaid(input, { given }) {
  const ids = indexIds(input);
  if (typeof input.query_text !== 'string') throw new Error('Send query_text: the words to look for.');
  if (input.limit !== undefined && !(Number.isInteger(input.limit) && input.limit >= 1)) throw new Error('limit must be a whole number of at least 1.');
  const limit = input.limit ?? 8;
  const words = (input.query_text.toLowerCase().match(WORD) ?? []).filter(word => word.length > 2);
  const lines = [];
  for (const id of ids) {
    const [descriptor] = (await descriptorReply(given, id)).items;
    const set = descriptor?.vector_set;
    if (!set?.items?.file || !set.points_to?.file || !set.points_to.text) throw new Error(`Descriptor ${id} needs vector_set.items.file and points_to: { file, text }.`);
    const rows = (await readFile(given, set.items.file)).toString('utf8').split('\n').filter(line => line.trim());
    for (const [index, line] of rows.entries()) {
      if (!words.length || lines.length >= limit) break;
      const item = JSON.parse(line);
      const said = String(item[set.points_to.text] ?? '').toLowerCase();
      if (words.every(word => said.includes(word))) lines.push({ address: `${set.items.file}#${index}`, ...pointOf(item, set.points_to) });
    }
  }
  return { index_ids: ids, lines };
}

// Discover and read each account index once per question. Keep every model and
// literal reader as an independent ranking for the account search finisher.
export function searchIndexPlaces(given, config, options = {}) {
  let descriptors;
  const encodings = new Map();
  const encoded = (encoder, question) => {
    const key = JSON.stringify([encoder, question]);
    if (!encodings.has(key)) encodings.set(key, (async () => {
      const answer = await given.run(encoder.tool, { texts: [question] });
      const value = answer?.result ?? answer;
      if (value?.model?.name !== encoder.name || value?.model?.pretrained !== encoder.pretrained
        || !Array.isArray(value.vectors?.[0]) || value.vectors[0].length !== encoder.dims
        || value.dims !== encoder.dims || !value.vectors[0].every(Number.isFinite)) {
        throw Object.assign(new Error('The query encoder returned a different model or an invalid vector.'), { code: 'query_model_mismatch' });
      }
      return Buffer.from(JSON.stringify({ vector: value.vectors[0] })).toString('base64');
    })());
    return encodings.get(key);
  };
  const inventory = () => descriptors ??= (async () => {
    const rows = [];
    for (const row of given.recordsOf('semantic-index-descriptor')) rows.push(row);
    return rows;
  })();
  const reasonOf = error => error?.code ?? 'refused';
  return async (lane, { question, report }, limit = config.limit) => {
  const hits = [];
  for (const { value: descriptor } of await inventory()) {
    if (Array.isArray(options.index_ids) && !options.index_ids.includes(descriptor?.index_id)) continue;
    const pointFields = descriptor?.vector_set?.points_to;
    const place = descriptor?.place ?? (pointFields?.text ? (pointFields.start ? 'said' : 'written') : 'seen');
    if (place !== lane.place) continue;
    const index = descriptor.index_id;
    const add = (point, item, match) => {
      if (typeof point?.file !== 'string' || !point.file) return;
      const identity = [point.identity, point.b2, point.file].find(value => typeof value === 'string' && value.length);
      hits.push({ ...item, id: `file:${identity}`, identity, key: `file:${identity}`,
        name: point.name ?? point.file.split('/').at(-1), path: point.file, file: point.file,
        start: point.start ?? 0, end: point.end ?? point.start ?? 0,
        timed: Number.isFinite(point.start), said: point.text ?? null,
        address: { resource: 'own-files', input: { name: identity } },
        evidence: { index_id: index, address: item.address, match, model_id: descriptor.model_id, model_version: descriptor.model_version },
        lane: { ...lane, id: `${lane.id}:${index}:${match}` } });
    };
    if (pointFields?.text) {
      try {
        const answer = await findWordsSaid({ index_ids: [index], query_text: question, limit }, { given });
        answer.lines.forEach((point, at) => add(point, { address: point.address, score: 1 / (at + 1) }, 'words'));
      } catch (error) { report.unavailable({ ...lane, id: `${lane.id}:${index}:words` }, reasonOf(error)); }
    }
    try {
      const encoder = config.encoders?.find(item => item.model_id === descriptor.model_id && item.model_version === descriptor.model_version);
      const supplied = options.query_vectors?.find(item => item.model_id === descriptor.model_id && item.model_version === descriptor.model_version);
      const answer = supplied
        ? await findSimilarVector({ index_id: index, query_vector_base64: supplied.vector_base64, limit }, { given })
        : encoder
        ? await findSimilarVector({ index_id: index, query_vector_base64: await encoded(encoder, question), limit }, { given })
        : await findSimilar({ index_id: index, query_text: question, limit }, { given });
      if (answer.result.skipped > 0) report.unavailable({ ...lane, id: `${lane.id}:${index}:meaning` }, 'unqualified_candidates');
      for (const item of answer.result.items) add(answer.points_to[item.address], item, 'meaning');
    } catch (error) { report.unavailable({ ...lane, id: `${lane.id}:${index}:meaning` }, reasonOf(error)); }
  }
  return hits;
  };
}
