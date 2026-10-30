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
    pointsTo.set(address, { file: item[field.file] ?? null, start: item[field.start] ?? null, end: item[field.end] ?? null, text: item[field.text] ?? null });
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

// action:index-content-vector and the batch plan for the whole set, then the find actions' preparation, ANN query,
// facts and rank. `query(work, descriptor)` writes embedding.json and vector.json the way each find action did.
async function run(input, door, query) {
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
    put(work, 'input.json', input);
    await step('node', 'nearest-embedding-facts.mjs', ['--embedding-json', join(work, 'embedding.json'), '--input-json', join(work, 'input.json'), '--descriptor-json', join(work, 'descriptor.json'), '--facts-json', join(work, 'facts.json'), '--output-json', join(work, 'nearest.json')], work);
    const result = take(work, 'nearest.json');
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
