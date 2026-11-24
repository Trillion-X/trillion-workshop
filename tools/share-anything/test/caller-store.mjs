// tools/share-anything/test/caller-store.mjs
//
// The caller's side of tool:share-anything, in three stores the person's own data could be in: a Map, a PGlite table and a JSON
// folder. Each store answers get(address) and put(address, value, kind) (value null withdraws). `callTool` reads what the tool
// needs, runs it, and applies its writes only while the store still holds each write's `expect` (a conflict throws, so nothing is
// written blind). Every name, label and time in the tests is made up.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { shareAnything } from '../do-work/share-anything.mjs';
import { endSharesWhoseConditionFailed } from '../do-work/end-shares-whose-condition-failed.mjs';
import { listRecordId } from '../read-data/share-label.mjs';

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The function has no record authority. `uses_tools` is the generator's conservative source-fetch closure, not a grant. */
export function assertNoRecordReach(row) {
  assert.equal(row.invoke.kind, 'container');
  assert.equal(row.invoke.internet, false);
  for (const field of ['records', 'credential_mounts', 'local_doors', 'parent_actions', 'by_input']) assert.equal(row.invoke[field], undefined, `no ${field}`);
  assert.equal(row.invoke_with, undefined, 'no redirection to another row');
  assert.equal(row.stored, undefined, 'no stored rights');
  assert.deepEqual(Object.keys(row.invoke.files), ['package_files'], 'only the declared source files are mounted');
  const { uses_tools: uses, ...admitted } = row;
  assert.ok(uses === undefined || (Array.isArray(uses) && uses.every(value => typeof value === 'string')), 'fetch dependencies are names only');
  assert.equal(/records:(read|write|list)|records-door|sharing\.(keep|list|withdraw)|@own-records/.test(JSON.stringify(admitted)), false, 'no records target or method is declared');
}

/** A Map store: the reference the other two must agree with. */
export function memoryStore(seed = {}) {
  const held = new Map(Object.entries(seed).map(([address, value]) => [address, { kind: 'seed', value }]));
  return {
    name: 'memory',
    async get(address) { return held.has(address) ? structuredClone(held.get(address).value) : null; },
    async put(address, value, kind = 'record') { held.set(address, { kind, value: value === null ? null : structuredClone(value) }); },
    async list(prefix) { return [...held].filter(([address, row]) => address.startsWith(prefix) && row.value !== null).map(([address, row]) => ({ address, value: structuredClone(row.value), kind: row.kind })); },
    async text() { return JSON.stringify([...held]); },
  };
}

/** A PGlite store: one table, one row per address; withdrawn is a row whose value is null. */
export async function pgliteStore(db, seed = {}) {
  await db.exec('create table if not exists records (address text primary key, kind text not null, value jsonb)');
  for (const [address, value] of Object.entries(seed)) await db.query('insert into records (address, kind, value) values ($1, $2, $3::jsonb) on conflict (address) do update set value = excluded.value', [address, 'seed', JSON.stringify(value)]);
  return {
    name: 'pglite',
    async get(address) {
      const { rows } = await db.query('select value from records where address = $1', [address]);
      return rows[0]?.value ?? null;
    },
    async put(address, value, kind = 'record') {
      await db.query('insert into records (address, kind, value) values ($1, $2, $3::jsonb) on conflict (address) do update set kind = excluded.kind, value = excluded.value', [address, kind, value === null ? null : JSON.stringify(value)]);
    },
    async list(prefix) {
      const { rows } = await db.query('select address, kind, value from records where address like $1 and value is not null order by address', [`${prefix}%`]);
      return rows;
    },
    async text() {
      const { rows } = await db.query('select address, kind, value from records order by address');
      return JSON.stringify(rows);
    },
  };
}

/** A JSON folder store: one file per address; a withdrawn record is a file whose value is null (nothing is deleted). */
export function jsonFolderStore(dir, seed = {}) {
  mkdirSync(dir, { recursive: true });
  const fileOf = address => join(dir, `${encodeURIComponent(address)}.json`);
  const write = (address, body) => {
    const tmp = `${fileOf(address)}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 2));
    renameSync(tmp, fileOf(address));
  };
  for (const [address, value] of Object.entries(seed)) write(address, { address, kind: 'seed', value });
  const read = address => (existsSync(fileOf(address)) ? JSON.parse(readFileSync(fileOf(address), 'utf8')) : null);
  return {
    name: 'json-folder',
    async get(address) { return read(address)?.value ?? null; },
    async put(address, value, kind = 'record') { write(address, { address, kind, value }); },
    async list(prefix) {
      const { readdirSync } = await import('node:fs');
      return readdirSync(dir).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')))
        .filter(row => row.address.startsWith(prefix) && row.value !== null).map(row => ({ address: row.address, value: row.value, kind: row.kind }));
    },
    async text() {
      const { readdirSync } = await import('node:fs');
      return readdirSync(dir).filter(name => name.endsWith('.json')).map(name => readFileSync(join(dir, name), 'utf8')).join('\n');
    },
  };
}

/** Applies the writes the tool returned, each only while the store still holds its `expect`. A conflict throws, writes nothing more. */
export async function applyWrites(store, writes = []) {
  for (const write of writes) {
    if (write.kind !== 'shared-text' && !same(await store.get(write.address), write.expect)) {
      throw new Error(`conflict at ${write.address}: the store changed since the tool read it; read again and run the tool again`);
    }
    await store.put(write.address, write.value, write.kind);
  }
  return writes.length;
}

/** The caller: reads what the tool needs from the store, runs the tool, applies its writes. */
export async function callTool(store, input) {
  const kept = input.grant ? await store.get(input.grant) : null;
  const stored = { kept };
  if (input.thing && input.thing.list !== undefined) stored.list = await store.get(listRecordId(input.thing.list));
  const answer = shareAnything({ ...input, stored });
  await applyWrites(store, answer.writes);
  return answer;
}

/** The caller of the sweep: lists the run shares from the store (their labels, rules and engine-reported last use) and applies what comes back. */
export async function callSweep(store, now, lastUsed = {}) {
  const runs = (await store.list('sharing:')).filter(row => row.kind === 'run-share')
    .map(row => ({ label: row.address, ...row.value, ...(row.address in lastUsed ? { last_used: lastUsed[row.address] } : {}) }));
  const answer = endSharesWhoseConditionFailed({ now, runs });
  await applyWrites(store, answer.writes);
  return answer;
}
