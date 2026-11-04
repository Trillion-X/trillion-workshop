import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';

const SEP = '\u0000', AFTER = '\u0001';
const prefix = `f${SEP}note${SEP}group${SEP}`;
const end = `${prefix.slice(0, -1)}${AFTER}`;
const key = (group, suffix) => `${prefix}${JSON.stringify(group)}${SEP}${suffix}`;
const groupEnd = key => `${prefix}${key.slice(prefix.length).split(SEP)[0]}${AFTER}`;
const oracle = (space, exclude = []) => {
  const groups = new Map();
  for (const pair of space.range(prefix, end)) {
    const group = pair[0].slice(prefix.length).split(SEP)[0];
    if (!exclude.includes(JSON.parse(group))) groups.set(group, pair);
  }
  return [...groups.values()];
};

test('group seeks retain full-key order and newest tombstone precedence across runs and memory', t => {
  const host = sqliteHost(':memory:'); t.after(() => host.db.close());
  const options = { transaction: host.transaction, prefix: 'group_seeks', page_bytes: 256, cache_bytes: 0, filter_bytes: 0, max_runs: 100 };
  let space = keptRuns(host.sql, options);
  const groups = ['', 'A', 'AA', 'A\u0000', 'A"', 'Z', '😀', null, false, 12];
  for (let run = 0; run < 4; run++) {
    for (const group of groups) for (let n = 0; n < 8; n++) space.put(key(group, `app${n % 2}${SEP}${run}:${n}`), { run, n });
    space.flush();
  }
  space.remove(key('A', `app1${SEP}3:7`)); space.flush();
  for (let run = 0; run < 4; run++) for (let n = 0; n < 8; n++) space.remove(key('Z', `app${n % 2}${SEP}${run}:${n}`));
  space.flush();
  space = keptRuns(host.sql, options);
  space.put(key('A', `app1${SEP}4:9`), { memory: true });
  space.remove(key('AA', `app1${SEP}3:7`));
  const include = key => JSON.parse(key.slice(prefix.length).split(SEP)[0]) !== '😀';
  assert.deepEqual(space.groupHeads(prefix, end, { groupEnd }), oracle(space));
  assert.deepEqual(space.groupHeads(prefix, end, { groupEnd, include }), oracle(space, ['😀']));
  assert.equal(space.groupHeads(prefix, end, { groupEnd }).some(([k]) => k.startsWith(`${prefix}"Z"${SEP}`)), false);
  assert.throws(() => space.groupHeads(prefix, end, { groupEnd: key => key }), /must advance/);
});

test('group heads open only the final live winning value, never obsolete or excluded spilled values', t => {
  const host = sqliteHost(':memory:'); t.after(() => host.db.close());
  const options = { transaction: host.transaction, prefix: 'group_values', page_bytes: 512, big_bytes: 256, cache_bytes: 0, max_runs: 20 };
  let space = keptRuns(host.sql, options);
  space.put(key('A', '1'), { old: 'x'.repeat(20000) });
  space.put(key('A', '2'), { old: 'y'.repeat(20000) });
  space.put(key('B', '1'), { excluded: 'z'.repeat(20000) }); space.flush();
  space.put(key('A', '1'), { current: 1 }); space.remove(key('A', '2')); space.flush();
  space = keptRuns(host.sql, options);
  const exec = host.sql.exec.bind(host.sql); let bigReads = 0;
  host.sql.exec = (query, ...args) => { if (query.includes('SELECT body FROM group_values_big')) bigReads++; return exec(query, ...args); };
  assert.deepEqual(space.groupHeads(prefix, end, { groupEnd, include: k => !k.startsWith(`${prefix}"B"${SEP}`) }), [[key('A', '1'), { current: 1 }]]);
  assert.equal(bigReads, 0);
});
