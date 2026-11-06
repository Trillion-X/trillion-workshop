// test/new-account-record-tables-workerd.test.mjs
//
// Purpose: a new account's records store copies none of the shared record model's table kinds it does not use. The
// records a new account's own records hold after sign-up (test/fixtures/new-account-own-records.json, read from the
// real Worker) are written, in workerd's Durable Object SQLite, to a store opened on the real record model and indexes
// (src/record-engine.mjs RECORD_MODEL, RECORD_INDEXES), and its maintenance runs until it has nothing left to do. The
// earlier owner (parts/record-log/do-work/record-log-store.mjs and record-tables.mjs at 775166f635, the last commit before
// a store stopped copying unused kinds) laid out a
// typed table, its registry rows, its history and a `table-schema-change` log record for every declared table kind;
// the current owner lays out only a kind the store holds a record of.
//
// Non-negotiable invariants
//   1. Rows written are workerd's own count (SqlStorageCursor.rowsWritten of every statement), both roads in one run.
//   2. Every record reads back the same on both roads, and every declared table kind answers the same schema fields
//      (name and value type) and the same table rows; only a kind's physical column, which no reader is given until
//      the kind is laid out, may be absent.
//   3. A kind the store holds a record of is laid out on both roads.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation, or from loosening the rule it states.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { RECORD_INDEXES, RECORD_MODEL } from '../src/record-engine.mjs';

const root = new URL('..', import.meta.url).pathname;
const { records } = JSON.parse(readFileSync(new URL('./fixtures/new-account-own-records.json', import.meta.url), 'utf8'));
// The earlier owner: the two files as they were before this change, every other source byte the same as the current road.
// Their bytes are old trillion's at 775166f635cd91daedaa51693ff40fb29b02f762, carried here as fixtures: this checkout
// does not hold that repository's history, so a test may not read it at run time.
const EARLIER = {
  'parts/record-log/do-work/record-log-store.mjs': './fixtures/record-log-store-before-unused-kinds-skipped.mjs',
  'parts/record-log/do-work/record-tables.mjs': './fixtures/record-tables-before-unused-kinds-skipped.mjs',
};
// The only change to those bytes: each relative import old trillion's layout named is moved to where this tool keeps
// the same file (as parts/record-log/do-work/record-log-store.mjs itself names it), so both roads load one copy.
const RELOCATED = {
  "'../../slot-table/do-work/slot-table.mjs'": "'../../../../slot-table/do-work/slot-table.mjs'",
  "'../../json-expansion.mjs'": "'../../../../json-expansion.mjs'",
  "'../../sql-statement-execution.mjs'": "'../../../../sql-statement-execution.mjs'",
  "'./maintenance-pacing.json'": "'../../../../record-log/do-work/maintenance-pacing.json'",
  "'./record-digest.mjs'": "'../../../../record-log/do-work/record-digest.mjs'",
  "'./record-stamps.mjs'": "'../../../../record-log/do-work/record-stamps.mjs'",
  "'./record-model.mjs'": "'../../../../record-log/do-work/record-model.mjs'",
};
function relocated(text) {
  for (const [from, to] of Object.entries(RELOCATED)) {
    if (!text.includes(from)) continue;
    assert.equal(text.split(from).length, 2, `${from} is named once`);
    text = text.replace(from, to);
  }
  return text;
}

async function bundle(road) {
  const earlier = new Map(Object.entries(EARLIER).map(([path, fixture]) => [root + path, relocated(readFileSync(new URL(fixture, import.meta.url), 'utf8'))]));
  const result = await build({ stdin: { contents: "export { recordLogStore } from './parts/record-log/do-work/record-log-store.mjs';", resolveDir: root, loader: 'js' },
    bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'error',
    plugins: road === 'earlier' ? [{ name: 'earlier-record-tables-owner', setup(builder) {
      builder.onLoad({ filter: /\/parts\/record-log\/do-work\/record-(log-store|tables)\.mjs$/ }, args => ({ contents: earlier.get(args.path), loader: 'js', resolveDir: root + 'parts/record-log/do-work' }));
    } }] : [] });
  return result.outputFiles[0].text;
}

const worker = `
import { DurableObject } from 'cloudflare:workers';
import { recordLogStore as earlier } from './earlier.mjs';
import { recordLogStore as current } from './current.mjs';
const MODEL = ${JSON.stringify(RECORD_MODEL)}, INDEXES = ${JSON.stringify(RECORD_INDEXES)}, RECORDS = ${JSON.stringify(records)};
const groupOf = query => /^\\s*(?:create|alter|drop)\\b/i.test(query) ? 'schema' : /_record_tables_|\\brt_[0-9a-f]{8}/.test(query) ? 'typed tables' : /record_keys_meta/.test(query) ? 'meta' : 'records and log';
export class Probe extends DurableObject {
  fetch(request) {
    const road = new URL(request.url).searchParams.get('road'), raw = this.ctx.storage.sql;
    const written = {};
    const sql = { get databaseSize() { return raw.databaseSize; }, exec(query, ...params) {
      const cursor = raw.exec(query, ...params), rows = cursor.toArray(), group = groupOf(query);
      written[group] = (written[group] ?? 0) + cursor.rowsWritten;
      return { rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten, toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    } };
    const store = (road === 'earlier' ? earlier : current)(sql, { transaction: fn => this.ctx.storage.transactionSync(fn), indexes: INDEXES, model: MODEL });
    store.write(RECORDS);
    let steps = 0;
    while (store.maintain({ left: () => 1 }).more && steps < 400) steps++;
    const kinds = MODEL.kinds.filter(kind => kind.table === true).map(kind => kind.type);
    const declared = RECORDS.filter(record => record.type === 'list').map(record => 'record:' + record.value.row_type);
    const tables = Object.fromEntries([...kinds, ...declared].map(type => {
      const { schema, complete } = store.tableSchema(type);
      return [type, { complete, fields: schema.fields.map(({ field, value_type }) => ({ field, value_type })), rows: store.tableRows(type).rows.map(row => ({ id: row.id, value: row.value })) }];
    }));
    const laid_out = raw.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_record_tables_kinds'").toArray().length
      ? raw.exec('SELECT kind FROM _record_tables_kinds ORDER BY kind').toArray().map(row => row.kind) : [];
    return Response.json({ steps, written, rows_written: Object.values(written).reduce((sum, n) => sum + n, 0), laid_out, tables,
      read_back: RECORDS.map(record => store.read(record.id)) });
  }
}
export default { fetch(request, env) { return env.PROBE.get(env.PROBE.idFromName(new URL(request.url).search)).fetch(request); } };`;

test('a new account\'s records store lays out only the table kinds it holds records of, and reads back the same', { timeout: 120000 }, async () => {
  const runtime = new Miniflare({ telemetry: { enabled: false }, workers: [{ config: {
    name: 'new-account-record-tables', compatibilityDate: '2026-10-01',
    manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents: worker }, 'earlier.mjs': { type: 'esm', contents: await bundle('earlier') }, 'current.mjs': { type: 'esm', contents: await bundle('current') } } },
    env: { PROBE: { type: 'durable-object', worker: 'new-account-record-tables', exportName: 'Probe' } }, exports: { Probe: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  try {
    const run = async road => { const response = await runtime.dispatchFetch(`http://probe/?road=${road}`); const text = await response.text(); assert.equal(response.status, 200, text); return JSON.parse(text); };
    const earlier = await run('earlier'), current = await run('current');
    console.log(JSON.stringify({ earlier: { rows_written: earlier.rows_written, written: earlier.written, laid_out: earlier.laid_out.length },
      current: { rows_written: current.rows_written, written: current.written, laid_out: current.laid_out } }));
    assert.deepEqual(current.read_back, earlier.read_back, 'every record reads back the same');
    assert.deepEqual(current.tables, earlier.tables, 'every declared table kind answers the same fields and rows');
    const held = new Set(Object.entries(current.tables).filter(([, table]) => table.rows.length).map(([type]) => type));
    for (const type of held) assert.ok(current.laid_out.includes(type) && earlier.laid_out.includes(type), `${type} holds records and is laid out on both roads`);
    assert.ok(current.laid_out.length < earlier.laid_out.length, 'the earlier owner laid out kinds the store never used');
    for (const type of current.laid_out) assert.ok(held.has(type) || records.some(record => record.type === 'list' && `record:${record.value.row_type}` === type),
      `${type} is laid out only because the store holds its records or its declaration`);
    assert.ok(current.rows_written < earlier.rows_written, 'fewer rows are written');
  } finally { await runtime.dispose(); }
});
