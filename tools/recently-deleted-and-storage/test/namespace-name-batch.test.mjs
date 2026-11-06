// Ported from old trillion test/namespace-name-batch.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The owner, namespace-store.mjs, moved here byte for byte; only the imports and
// the Workerd probe's source path and bundle directory changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { namespaceStore } from '../namespace-store.mjs';

const byName = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function fixture(namespaceStore, sql, aliasCount, namesPerIdentity, large = false) {
  const store = namespaceStore(sql), canonical = 'canonical';
  sql.exec("INSERT INTO namespace_files (identity,byte_length,media_type,origin,key,part_bytes,stored_at,checked_at) VALUES (?,10,'application/octet-stream','test','object',0,'2026-10-12','2026-10-12')", canonical);
  const aliases = Array.from({ length: aliasCount }, (_, index) => 'alias-' + String(index).padStart(3, '0'));
  for (const alias of aliases) sql.exec("INSERT INTO namespace_aliases (alias,identity,grade,added_at) VALUES (?,?,'attested','2026-10-12')", alias, canonical);
  const saved = new Map(), identities = [canonical, ...aliases];
  for (let group = 0; group < identities.length; group++) {
    const names = Array.from({ length: namesPerIdentity }, (_, index) => {
      // Names inserted after the oldest 20 sort before them. A global name
      // LIMIT, an alphabetic per-identity limit, or unordered sample is wrong.
      const base = index >= 20 ? '/000-hidden-' : '/z-' + (index % 2 ? '\u{1f600}' : '\ue000');
      return base + group + '-' + String(namesPerIdentity - index).padStart(4, '0')
        + (large ? '-'.repeat(index < 3 ? 120000 : 4000) : '') + (index % 2 ? '.mov' : '.png');
    });
    saved.set(identities[group], names);
    for (let from = 0; from < names.length; from += 32) sql.exec(`INSERT INTO namespace_names (name,collection,identity,byte_length,named_at)
      SELECT value,'/',?,10,'2026-10-12' FROM json_each(?)`, identities[group], JSON.stringify(names.slice(from, from + 32)));
  }
  const expected = [...new Set([canonical, ...aliases.slice(0, 20)].flatMap(identity => saved.get(identity).slice(0, 20)))].sort(byName).slice(0, 20);
  return { store, canonical, aliases, saved, expected };
}

test('canonical, alias, arrival and exact-name reads preserve oldest samples and JavaScript collation', () => {
  const host = sqliteHost(':memory:');
  try {
    const value = fixture(namespaceStore, host.sql, 24, 40);
    assert.deepEqual(value.store.locate(value.canonical).names, value.expected);
    assert.deepEqual(value.store.locate(value.aliases[3]).names, value.expected);
    assert.deepEqual(value.store.locateForArrival(value.canonical).names, value.expected);
    assert.equal(value.store.locate(value.canonical).aliases.length, 24, 'full alias metadata is retained');
    const requested = value.saved.get(value.aliases[23]).at(-1);
    const exact = value.store.byName(requested);
    assert.deepEqual(exact.names, [requested, ...value.expected.filter(name => name !== requested)].slice(0, 20).sort(byName));
    assert.equal(exact.identity, value.canonical);
    assert.equal(value.store.byName('/absent'), null);
    // A canonical identity may also be a declared alias. It is sampled once;
    // duplicates never use up one of the final 20 unique display names.
    host.sql.exec("INSERT INTO namespace_aliases (alias,identity,grade,added_at) VALUES (?,?,'attested','2026-10-12')", value.canonical, value.canonical);
    assert.deepEqual(value.store.locateForArrival(value.canonical).names, value.expected);
    host.sql.exec('DELETE FROM namespace_aliases WHERE alias != ?', value.canonical);
    assert.deepEqual(value.store.locateForArrival(value.canonical).names, value.saved.get(value.canonical).slice(0, 20).sort(byName));
  } finally { host.db.close(); }
});

test('large historical names remain individual result rows rather than one aggregate value', () => {
  const host = sqliteHost(':memory:');
  try {
    const value = fixture(namespaceStore, host.sql, 1, 25, true);
    assert.deepEqual(value.store.locate(value.canonical).names, value.expected);
    const name = value.saved.get(value.aliases[0]).at(-1);
    assert.ok(value.store.byName(name).names.includes(name));
    const growing = 'up:' + 'a'.repeat(32);
    value.store.startGrowing({ growing, byte_length: 10, media_type: 'image/png', origin: 'test', aliases: [] });
    value.store.putNames(Array.from({ length: 40 }, (_, index) => ({ name: '/growing-' + String(40 - index).padStart(3, '0') + '.png', identity: growing, byte_length: 10 })));
    const expected = Array.from({ length: 20 }, (_, index) => '/growing-' + String(40 - index).padStart(3, '0') + '.png').sort(byName);
    assert.deepEqual(value.store.locate(growing).names, expected, 'growing owner retains its direct first-20 sample');
    const exact = value.store.byName('/growing-001.png');
    assert.equal(exact.growing, true); assert.ok(exact.names.includes('/growing-001.png'));
  } finally { host.db.close(); }
});

test('real Workerd batches alias-name seeks with bounded physical reads and unchanged answers', { timeout: 120000 }, async () => {
  const source = readFileSync(new URL('../namespace-store.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  const namesOfFile = '), end = source.indexOf('\n  // Whether a name\'s file is kept:', start);
  assert.ok(start >= 0 && end > start, 'exact names owner source boundary');
  const original = "  const namesOfFile = (identity, aliases) => [...new Set([identity, ...aliases.slice(0, NAMES_OF_FILE).map(item => item.alias)]\n    .flatMap(held => all('SELECT name FROM namespace_names WHERE identity = ? ORDER BY rowid LIMIT ?', held, NAMES_OF_FILE).map(item => item.name)))]\n    .sort(byName).slice(0, NAMES_OF_FILE);\n";
  const modules = {}, root = new URL('..', import.meta.url).pathname;
  for (const [kind, contents] of [['before', source.slice(0, start) + original + source.slice(end)], ['after', source]]) {
    const result = await build({ stdin: { contents, loader: 'js', resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'esm', logLevel: 'error' });
    modules[kind + '.mjs'] = { type: 'esm', contents: result.outputFiles[0].text };
  }
  const worker = `
import {DurableObject} from 'cloudflare:workers';
import {namespaceStore as before} from './before.mjs';
import {namespaceStore as after} from './after.mjs';
const byName=${byName.toString()};
const fixture=${fixture.toString()};
export class Probe extends DurableObject {
  fetch(request) {
    const url=new URL(request.url),raw=this.ctx.storage.sql;
    let measuring=false,cost={statements:0,rows_read:0,rows_written:0,name_statements:0};
    const sql={exec(query,...params){const cursor=raw.exec(query,...params),rows=cursor.toArray();
      if(measuring){cost.statements++;cost.rows_read+=cursor.rowsRead;cost.rows_written+=cursor.rowsWritten;
        if((query.includes('SELECT name FROM namespace_names WHERE identity = ?')&&query.includes('ORDER BY rowid'))||query.includes('SELECT name FROM (SELECT name FROM namespace_names WHERE identity = ?'))cost.name_statements++;}
      return{toArray:()=>rows,[Symbol.iterator]:()=>rows[Symbol.iterator]()};}};
    const value=fixture(url.searchParams.get('kind')==='before'?before:after,sql,Number(url.searchParams.get('aliases')),Number(url.searchParams.get('names')));
    measuring=true;const found=value.store.locateForArrival(value.canonical);measuring=false;
    return Response.json({cost,names:found.names,expected:value.expected,media_type:found.media_type});
  }
}
export default{fetch(request,env){const url=new URL(request.url);return env.PROBE.get(env.PROBE.idFromName(url.search)).fetch(request);}};`;
  const runtime = new Miniflare({ telemetry: { enabled: false }, workers: [{ config: {
    name: 'namespace-name-batch', compatibilityDate: '2026-10-01',
    manifest: { mainModule: 'worker.mjs', modules: { ...modules, 'worker.mjs': { type: 'esm', contents: worker } } },
    env: { PROBE: { type: 'durable-object', worker: 'namespace-name-batch', exportName: 'Probe' } }, exports: { Probe: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  try {
    const samples = [];
    for (const aliases of [0, 4, 20]) for (const names of [40, 160]) {
      const read = async kind => { const response = await runtime.dispatchFetch('http://cost/names?aliases=' + aliases + '&names=' + names + '&kind=' + kind); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
      const old = await read('before'), next = await read('after');
      assert.deepEqual(next.names, old.names); assert.deepEqual(next.names, next.expected);
      assert.equal(next.media_type, old.media_type);
      assert.equal(old.cost.name_statements, aliases + 1); assert.equal(next.cost.name_statements, Math.ceil((aliases + 1) / 5));
      assert.equal(old.cost.statements - next.cost.statements, aliases + 1 - Math.ceil((aliases + 1) / 5));
      assert.equal(old.cost.rows_written, 0); assert.equal(next.cost.rows_written, 0);
      // A rowid-only correlated sample cannot allocate a growing array of names.
      // Physical index/rowid accounting is runtime-specific and reported below;
      // the permissive bound catches an accidental whole-identity/table scan.
      assert.ok(next.cost.rows_read <= old.cost.rows_read, JSON.stringify({ aliases, names, old: old.cost, next: next.cost }));
      samples.push({ aliases, names, before: old.cost, after: next.cost });
    }
    for (const aliases of [0, 4, 20]) {
      const [small, large] = samples.filter(sample => sample.aliases === aliases);
      assert.deepEqual(large.before, small.before, 'original per-identity sample remains flat');
      assert.deepEqual(large.after, small.after, 'batched sample reads remain flat with fourfold stored names');
    }
    console.log(JSON.stringify({ runtime: 'workerd', source_only: true, samples }));
  } finally { await runtime.dispose(); }
});
