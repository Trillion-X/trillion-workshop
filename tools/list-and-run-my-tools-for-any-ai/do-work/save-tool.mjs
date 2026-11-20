// tools/list-and-run-my-tools-for-any-ai/do-work/save-tool.mjs
//
// save_tool, ported from the old server (src/workshop.mjs saveTool at b6ae0ebf815f:1455, its descriptor check at 1283
// and its files helper at 1366). A saved tool is one row of the `saved_tools` table in the database the run's input names. The
// table is this tool's own fixed name and is made when missing (each owner's AI makes its own tables), so a caller cannot choose
// a table. The statements go through the tool's own mounted connection (descriptor 3, the same mount sales-contract-sql.mjs uses),
// never through a nested call to tool:run-sql.
//
// The row holds the id, the descriptor as JSON, the tool's files as one gzipped tar, a fingerprint (BLAKE3 of those bytes, as the
// old code wrote it: '1f:' + hex) and made_at. The descriptor is admitted by the ai-tool-catalog owner's admitToolDescriptor, the
// same check a catalog row gets, so a saved tool and a catalog tool are judged by one rule.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { admitToolDescriptor, toolLineProblems } from '../../ai-tool-catalog/read-data/read-ai-tool-catalog.ts';
import { tarGz } from '../../keep-and-wake-ai-sessions-on-this-computer/src/tar-gz.mjs';

export const SAVED_TABLE = 'saved_tools';
export const MAX_SAVED_BYTES = 20 * 1024 * 1024;
const TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${SAVED_TABLE} (
  id text PRIMARY KEY,
  descriptor jsonb NOT NULL,
  files bytea NOT NULL,
  fingerprint text NOT NULL,
  made_at timestamptz NOT NULL
)`;

export class SaveToolError extends Error {}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim() !== '';

export const fingerprintOf = bytes => '1f:' + bytesToHex(blake3(bytes));

/** The files a caller sends as {"main.py": "<text>"}, as one gzipped tar placed under the invoke's workdir. */
export function filesAsBytes(files, workdir) {
  if (!object(files) || !Object.keys(files).length) {
    throw new SaveToolError('files must be an object of file names to their text, for example {"main.py": "print(1)"}.');
  }
  const root = String(workdir ?? '/work').replace(/^\/+|\/+$/g, '');
  const entries = Object.entries(files).map(([name, text]) => {
    if (!nonempty(name) || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '')) {
      throw new SaveToolError(`files: "${name}" must be a path inside the tool, like "main.py" or "lib/util.py".`);
    }
    if (typeof text !== 'string') throw new SaveToolError(`files: "${name}" must be the file's text.`);
    return { name: `${root}/${name}`, bytes: new TextEncoder().encode(text), executable: text.startsWith('#!') };
  });
  return tarGz(entries);
}

/** Every reason the descriptor is refused, in plain words. An empty list means it may be saved. */
export function descriptorProblems(row) {
  const problems = toolLineProblems(row);
  if (!nonempty(row.id)) problems.push('id: a short unique name for the tool, for example "tool:count-words".');
  if (!nonempty(row.job)) problems.push('job: what the tool does, in plain words, as someone would ask for it.');
  if (!object(row.input_schema) || row.input_schema.type !== 'object') {
    problems.push('input_schema: a JSON Schema with "type": "object" and a property for each input the tool takes.');
  }
  if (row.output_schema !== undefined && !object(row.output_schema)) {
    problems.push('output_schema: a JSON Schema for what the tool returns, or leave it out.');
  }
  const invoke = row.invoke;
  if (!object(invoke) || !nonempty(invoke.kind)) {
    problems.push('invoke: how the tool runs, an object with a kind: "container" (your own code, sent in files).');
  } else if (invoke.kind === 'container') {
    if (!Array.isArray(invoke.argv) || !invoke.argv.length) {
      problems.push('invoke.argv: the command that runs the tool, as a list, run in /work without a shell.');
    }
  }
  const admitted = admitToolDescriptor({ kind: 'ai-tool-descriptor', ...row });
  if (admitted.refused) problems.push(admitted.refused.reason);
  return problems;
}

/** The table, made when missing. Run once before each save, as the sales-contract store does. */
// A deleted tool keeps its row with status 'deleted' and the time it was deleted (the old deleteTool kept the same), so a
// publish or a delete never reads it as a live saved tool. Both columns are added to tables made before this change.
const ADD_STATUS_SQL = [
  `ALTER TABLE ${SAVED_TABLE} ADD COLUMN IF NOT EXISTS status text`,
  `ALTER TABLE ${SAVED_TABLE} ADD COLUMN IF NOT EXISTS deleted_at timestamptz`,
];

export async function ensureSavedTable(client) {
  await client.query(TABLE_SQL, []);
  for (const sql of ADD_STATUS_SQL) await client.query(sql, []);
}

/**
 * Save one tool into `saved_tools` through `client` (query(text, values) → { rows, rowCount }).
 * `input` is { descriptor, files } or { descriptor, bytes_base64 }; never both. A tool whose invoke is an account action
 * runs no code of its own, so it is saved with no files at all (`{ descriptor }`). Returns the saved summary.
 */
export async function saveTool(input, client) {
  const asked = object(input) ? input : {};
  const { descriptor, files, bytes_base64: bytesBase64 } = asked;
  if (!object(descriptor)) throw new SaveToolError('descriptor is required: the tool as an ai-tool-descriptor object.');
  const codeFree = descriptor.invoke?.kind === 'account-action' && files === undefined && bytesBase64 === undefined;
  if (!codeFree && (files === undefined) === (bytesBase64 === undefined)) {
    throw new SaveToolError('send the tool code as files or as bytes_base64, exactly one of them.');
  }
  const problems = descriptorProblems(descriptor);
  if (problems.length) throw new SaveToolError(`The tool was not saved: ${problems.join(' ')}`);
  const bytes = codeFree ? Buffer.alloc(0)
    : files !== undefined
      ? filesAsBytes(files, descriptor.invoke?.workdir)
      : Buffer.from(String(bytesBase64), 'base64');
  if (bytes.length > MAX_SAVED_BYTES) throw new SaveToolError(`The tool's files are over ${MAX_SAVED_BYTES} bytes.`);
  const id = descriptor.id;
  const fingerprint = fingerprintOf(bytes);
  await ensureSavedTable(client);
  // One upsert: the same id replaces the saved tool it names; made_at is set on each save, and saving again revives a deleted id.
  await client.query(
    `INSERT INTO ${SAVED_TABLE} (id, descriptor, files, fingerprint, made_at)
     VALUES ($1, $2::jsonb, $3, $4, $5::timestamptz)
     ON CONFLICT (id) DO UPDATE SET descriptor = EXCLUDED.descriptor, files = EXCLUDED.files,
       fingerprint = EXCLUDED.fingerprint, made_at = EXCLUDED.made_at, status = NULL, deleted_at = NULL`,
    [id, JSON.stringify(descriptor), bytes, fingerprint, new Date().toISOString()],
  );
  return { id, fingerprint, bytes: bytes.length, table: SAVED_TABLE, saved: true };
}
