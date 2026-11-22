import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
// tools/build-and-send-a-sales-contract/do-work/sales-contract-sql.mjs
//
// tool:sales-contracts, one container process (tool-rows.json): save, list and read sales contracts as rows of a
// `sales_contracts` table in the selling pursuit's own database. The tool makes the table itself (each owner's AI makes its own
// tables). A save is one upsert, a list is one page of one select, a read is one select. The rules are the store's
// (sales-contract-records.mjs cleanContract): a contract needs a name and a list of primitives, and nothing here fixes a price,
// a term or a billing period.
//
// The connection string is a held value the engine hands this process on descriptor 3 (the row's invoke.credential_mounts), named
// by the request's `database` (or `credential_name`); it is never in the request, argv, a file or the environment. The statements
// go through the extended protocol, one statement per call, as the run-sql tool does; the proxy is run-sql's own
// (through-the-run-proxy.mjs, the same file in this container).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cleanContract, SalesContractsError } from './sales-contract-records.mjs';
import { throughProxy } from '../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs';

export const CONTRACT_TABLE = 'sales_contracts';
const CONNECTION_DESCRIPTOR = 3;
const MOST_ROWS = 100;
const TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${CONTRACT_TABLE} (
  id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL,
  contract jsonb NOT NULL,
  share_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  removed_at timestamptz
)`;
const COLUMNS = 'id, name, status, contract, share_id, created_at, updated_at';

// A saved contract as the store answers it: the same keys sales-contract-records.mjs writes.
const shaped = row => ({
  id: row.id, kind: 'sales-contract', status: row.status, name: row.name, contract: row.contract,
  created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString(),
  ...(row.share_id ? { share_id: row.share_id } : {}),
});

/** Every statement the actions run, through one client: { query(text, values) → { rows, rowCount } }. */
export async function runSalesContracts(input, client) {
  const asked = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  await client.query(TABLE_SQL, []);
  if (asked.action === 'save') return save(asked, client);
  if (asked.action === 'list') return list(asked, client);
  if (asked.action === 'read') return read(asked, client);
  throw new SalesContractsError('action must be save, list or read.');
}

async function save(asked, client) {
  if (asked.contract_id !== undefined && (typeof asked.contract_id !== 'string' || !asked.contract_id.trim())) {
    throw new SalesContractsError('contract_id must be the id of a sales contract, as text.');
  }
  const contract = cleanContract(asked.contract);
  const id = asked.contract_id?.trim() || `sales-contract:${randomUUID()}`;
  const at = new Date().toISOString();
  // One upsert: a new contract is inserted, an existing one keeps its creation time and its share id; a removed one is not revived.
  const { rows } = await client.query(
    `INSERT INTO ${CONTRACT_TABLE} (id, name, status, contract, created_at, updated_at)
     VALUES ($1, $2, 'draft', $3::jsonb, $4::timestamptz, $4::timestamptz)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, contract = EXCLUDED.contract, updated_at = EXCLUDED.updated_at
     WHERE ${CONTRACT_TABLE}.removed_at IS NULL
     RETURNING ${COLUMNS}`,
    [id, contract.name.trim(), JSON.stringify(contract), at],
  );
  if (!rows.length) throw new SalesContractsError(`The sales contract ${id} was removed; save the terms as a new contract.`);
  return shaped(rows[0]);
}

async function list(asked, client) {
  const limit = asked.limit === undefined ? 50 : asked.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MOST_ROWS) throw new SalesContractsError(`limit must be a whole number from 1 to ${MOST_ROWS}.`);
  const after = asked.after === undefined ? null : asked.after;
  let cursor = null;
  if (after !== null) {
    try { cursor = JSON.parse(after); } catch { throw new SalesContractsError('after is the next cursor a list answered.'); }
    if (typeof cursor?.updated_at !== 'string' || typeof cursor?.id !== 'string') throw new SalesContractsError('after is the next cursor a list answered.');
  }
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM ${CONTRACT_TABLE}
     WHERE removed_at IS NULL AND ($1::timestamptz IS NULL OR (updated_at, id) < ($1::timestamptz, $2::text))
     ORDER BY updated_at DESC, id DESC LIMIT $3`,
    [cursor?.updated_at ?? null, cursor?.id ?? '', limit],
  );
  const last = rows.at(-1);
  return {
    contracts: rows.map(shaped),
    count: rows.length,
    ...(rows.length === limit ? { next: JSON.stringify({ updated_at: new Date(last.updated_at).toISOString(), id: last.id }) } : {}),
  };
}

async function read(asked, client) {
  if (typeof asked.contract_id !== 'string' || !asked.contract_id.trim()) throw new SalesContractsError('Give contract_id, the id of a sales contract.');
  const { rows } = await client.query(`SELECT ${COLUMNS} FROM ${CONTRACT_TABLE} WHERE id = $1 AND removed_at IS NULL`, [asked.contract_id]);
  if (!rows.length) throw new SalesContractsError(`There is no sales contract ${asked.contract_id} in this account.`);
  return shaped(rows[0]);
}

/** The process entry: one JSON request on stdin, the connection on descriptor 3, one JSON answer on stdout. */
export async function main() {
  const { default: pg } = await import('pg');
  const request = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const connection = readFileSync(CONNECTION_DESCRIPTOR, 'utf8').trim();
  const proxy = process.env.HTTPS_PROXY;
  const client = new pg.Client({ connectionString: connection, ...(proxy ? { stream: throughProxy(proxy) } : {}) });
  await client.connect();
  try {
    return { result: await runSalesContracts(request, client) };
  } finally {
    await client.end();
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main().then(answer => console.log(JSON.stringify(answer))).catch(error => {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
}
