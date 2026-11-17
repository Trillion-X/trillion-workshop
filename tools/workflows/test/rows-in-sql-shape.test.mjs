// tools/workflows: every descriptor of this folder that keeps rows in the person's own Postgres has the one row shape
// (README "Keeping rows in SQL"): no records door and no records right, the held connection string on descriptor 3, the one
// local door, no internet, the pg libraries pinned exactly as tool:run-sql-in-my-database pins them, and the entry program that
// matches whether it also reads the person's files. The folder's other descriptors keep no rows in SQL and are named here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runSqlDescriptor } from '../test-helpers/rows-in-sql.mjs';

const load = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')).records.map(record => record.payload);
const workflows = load('../tool-rows.json').filter(row => row.kind === 'ai-tool-descriptor');
const runSql = runSqlDescriptor();
const inSql = workflows.filter(row => row.invoke?.credential_mounts?.some(mount => mount.secret_name === 'own-rows-postgres-connection'));
const pgFiles = runSql.invoke.files.package_files.filter(spec => spec.packages);

test('the descriptors that keep rows in SQL are the workflow starters, chooser and step tools', () => {
  assert.deepEqual(inSql.map(row => row.id).sort(), [
    'tool:choose-the-workflows-that-fire', 'tool:start-a-recipe-run', 'tool:start-a-recipe-step',
    'tool:start-a-steps-agents', 'tool:submit-a-recipe-step', 'tool:submit-a-step-that-slots-rows',
  ]);
});

test('no descriptor that keeps rows in SQL holds a records right on a kind of row', () => {
  for (const row of inSql) {
    const kinds = (row.invoke?.records?.rights ?? []).filter(right => right.kind !== undefined || right.operations?.some(operation => operation.startsWith('records:')));
    assert.deepEqual(kinds, [], `${row.id} keeps no rights on kinds of row`);
  }
});

test('each descriptor reaches only the local port the computer reports, with the held connection on descriptor 3 and the pinned pg libraries', () => {
  for (const row of inSql) {
    const { invoke } = row;
    assert.equal(invoke.internet, false, row.id);
    assert.deepEqual(invoke.local_doors, ['own-rows-postgres'], row.id);
    assert.deepEqual(invoke.credential_mounts, [{ secret_name: 'own-rows-postgres-connection', fd: 3 }], row.id);
    assert.deepEqual(invoke.packages, runSql.invoke.packages, row.id);
    assert.deepEqual(invoke.files.package_files.filter(spec => spec.packages?.[0] && !spec.packages[0].startsWith('node_modules/')), pgFiles, row.id);
    assert.deepEqual(row.verify.map(item => item.kind), ['needs-a-machine'], `${row.id} needs a real server to run`);
    assert.ok(invoke.files.package_files.find(spec => spec.package === 'workflows').paths.includes('sql'), `${row.id} packs the tables it makes`);
  }
});

test('a descriptor that reads no files runs run-with-sql.mjs and packs no records door; one that reads a copy of a repository keeps only its files right, on descriptor 4', () => {
  for (const row of inSql) {
    const { invoke } = row;
    const withFiles = invoke.records !== undefined;
    assert.equal(invoke.argv[1], `/opt/workflows/do-work/run-with-sql${withFiles ? '-and-files' : ''}.mjs`, row.id);
    assert.equal(invoke.files.package_files.some(spec => spec.package === 'records-door'), withFiles, row.id);
    if (!withFiles) continue;
    assert.deepEqual(invoke.argv.slice(-2), ['--files-door-fd', '4'], row.id);
    assert.equal(invoke.records.fd, 4, row.id);
    assert.ok(invoke.records.rights.length > 0 && invoke.records.rights.every(right => right.files), row.id);
  }
});
