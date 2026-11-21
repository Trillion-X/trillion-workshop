// The settings table's statements and answers on made-up rows: the role, the read, the create, the compare-and-set
// writes with a stand-in for tool:run-sql-in-my-database that keeps its rows in memory, the carry, and the timeouts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRecord } from '../read-data/settings.mjs';
import { settingsRoleOf, createRequest, readRequest, recordsOf, writeRequests, writeOutcome, carryRequests, SettingsStoreError, MISSING_ROLE_WORDS } from '../read-data/settings-store.mjs';

const role = { credential_name: 'own-rows-postgres-connection', table: 'public.tool_settings' };
const ownerPlaces = { roles: { settings: { credential_name: 'own-rows-postgres-connection', table: 'public.tool_settings' } } };
const make = (kind, scope, values, status) => makeRecord('make-a-sample', kind, scope, values, { name: 'sample', tool: 'tool:make-a-sample', source: 'tools/sample/settings.json@0000000', status });

// A stand-in for tool:run-sql-in-my-database: it answers the statements the store makes against rows kept in memory,
// and refuses any statement without a statement_timeout_ms.
function standIn(rows) {
  const seen = [];
  const run = input => {
    seen.push(input);
    assert.ok(Number.isInteger(input.statement_timeout_ms) && input.statement_timeout_ms > 0, 'every statement carries statement_timeout_ms');
    if (input.sql.startsWith('CREATE TABLE IF NOT EXISTS public.tool_settings')) return { row_count: 0, rows: [] };
    if (input.sql.startsWith('SELECT')) {
      const [prefix] = input.params;
      return { columns: ['id'], rows: rows.filter(row => row.id.startsWith(prefix)).sort((a, b) => a.id.localeCompare(b.id)), row_count: 0 };
    }
    if (input.sql.startsWith('INSERT')) {
      const [id, name, tool, scope_kind, scope_id, settings, source, status] = input.params;
      if (rows.some(row => row.id === id)) return { rows: [], row_count: 0 };
      rows.push({ id, name, tool, scope_kind, scope_id, settings: JSON.parse(settings), source, status, version: 1 });
      return { rows: [], row_count: 1 };
    }
    if (input.sql.startsWith('UPDATE')) {
      const [id, name, tool, scope_kind, scope_id, settings, source, status, version] = input.params;
      const row = rows.find(r => r.id === id && r.version === Number(version));
      if (!row) return { rows: [], row_count: 0 };
      Object.assign(row, { name, tool, scope_kind, scope_id, settings: JSON.parse(settings), source, status, version: row.version + 1 });
      return { rows: [], row_count: 1 };
    }
    throw new Error(`stand-in met an unknown statement: ${input.sql}`);
  };
  return { run, seen };
}

// What a read's answer looks like once the table's rows come back from the run (settings::text is JSON text).
const asRead = rows => ({ rows: rows.map(row => ({ ...row, settings: JSON.stringify(row.settings) })) });

test('the role is read from the owner-places record, and a missing role is none with words saying so', () => {
  assert.deepEqual(settingsRoleOf(ownerPlaces), role);
  assert.deepEqual(settingsRoleOf(JSON.stringify(ownerPlaces)), role);
  assert.equal(settingsRoleOf({ roles: { goals: { credential_name: 'x-connection', table: 'public.goals' } } }), null);
  assert.match(MISSING_ROLE_WORDS, /no settings role/);
  assert.throws(() => settingsRoleOf({ roles: { settings: { credential_name: 'not-named-right', table: 'public.tool_settings' } } }), SettingsStoreError);
  assert.throws(() => settingsRoleOf({ roles: { settings: { credential_name: 'own-rows-postgres-connection', table: 'tool_settings; drop table x' } } }), SettingsStoreError);
});

test('every statement carries its statement_timeout_ms and names only the role table', () => {
  const requests = [createRequest(role), readRequest(role, 'make-a-sample'), ...writeRequests(role, [{ id: 'record:setting:make-a-sample~film~f1', type: 'record:setting', value: make('film', 'f1', { a: 1 }).value, expected: null }])];
  for (const request of requests) {
    assert.equal(request.input.statement_timeout_ms, 5000);
    assert.equal(request.input.credential_name, 'own-rows-postgres-connection');
    assert.match(request.input.sql, /public\.tool_settings/);
  }
  assert.equal(readRequest(role, 'make-a-sample').input.params[0], 'record:setting:make-a-sample~');
  assert.throws(() => readRequest(role, 'a~b'), SettingsStoreError);
});

test('a read gives the reader its records, and a table not there yet gives none', () => {
  const rows = [{ id: 'record:setting:make-a-sample~film~f1', name: 'sample', tool: 'tool:make-a-sample', scope_kind: 'film', scope_id: 'f1', settings: { pace: 2 }, source: 'x@0', status: 'active', version: '3' }];
  const { records, missing } = recordsOf(asRead(rows));
  assert.equal(missing, false);
  assert.deepEqual(records[0], { id: 'record:setting:make-a-sample~film~f1', type: 'record:setting',
    value: { name: 'sample', tool: 'tool:make-a-sample', scope_kind: 'film', scope_id: 'f1', settings: '{"pace":2}', from: 'x@0', status: 'active', version: 3 } });
  assert.deepEqual(recordsOf({ error: 'ERROR: relation "public.tool_settings" does not exist (SQLSTATE 42P01)' }), { records: [], missing: true });
  assert.throws(() => recordsOf({ error: 'permission denied for table tool_settings' }), SettingsStoreError);
});

test('a keep with no expected row is an insert that does nothing when the id is taken', () => {
  const rows = [];
  const keep = [{ ...make('film', 'f1', { a: 1 }), expected: null }];
  const [create, insert] = writeRequests(role, keep);
  assert.equal(create.input.sql.startsWith('CREATE TABLE IF NOT EXISTS'), true);
  assert.match(insert.input.sql, /ON CONFLICT \(id\) DO NOTHING/);
  const fake = standIn(rows);
  fake.run(create.input);
  assert.deepEqual(writeOutcome(insert, fake.run(insert.input)), { id: keep[0].id, written: true, words: `${keep[0].id} written.` });
  const again = writeOutcome(insert, fake.run(insert.input));
  assert.equal(again.written, false);
  assert.match(again.words, new RegExp(`${keep[0].id}.*already exists`));
});

test('a keep over an expected row is a compare-and-set: a row that changed is refused by its id, never overwritten', () => {
  const rows = [{ id: 'record:setting:make-a-sample~film~f1', name: 'sample', tool: 'tool:make-a-sample', scope_kind: 'film', scope_id: 'f1', settings: { pace: 2 }, source: 'x@0', status: 'active', version: 1 }];
  const read = recordsOf(asRead(rows)).records[0];
  const fake = standIn(rows);
  const first = writeRequests(role, [{ ...make('film', 'f1', { pace: 3 }), expected: read }]).at(-1);
  assert.match(first.input.sql, /WHERE id = \$1 AND version = \$9/);
  assert.equal(first.input.params.at(-1), 1);
  assert.equal(writeOutcome(first, fake.run(first.input)).written, true);
  assert.equal(rows[0].version, 2);
  assert.deepEqual(rows[0].settings, { pace: 3 });
  // Someone else wrote the row after `read`: the same write now changes nothing and says so.
  const stale = writeRequests(role, [{ ...make('film', 'f1', { pace: 9 }), expected: read }]).at(-1);
  const outcome = writeOutcome(stale, fake.run(stale.input));
  assert.equal(outcome.written, false);
  assert.match(outcome.words, /record:setting:make-a-sample~film~f1 was not written: its row has changed since version 1 was read/);
  assert.deepEqual(rows[0].settings, { pace: 3 });
});

test('a row handed back without a version is refused before any write', () => {
  assert.throws(() => writeRequests(role, [{ ...make('film', 'f1', {}), expected: { type: 'record:setting', value: {} } }]), SettingsStoreError);
});

test('the carry inserts only the setting rows handed in, and changes no row that exists', () => {
  const rows = [{ id: 'record:setting:make-a-sample~film~f1', name: 'kept', tool: 'tool:make-a-sample', scope_kind: 'film', scope_id: 'f1', settings: { pace: 5 }, source: 'x@0', status: 'active', version: 1 }];
  const stored = [make('film', 'f1', { pace: 2 }), make('account', 'main', { pace: 1 }), { id: 'list:settings', type: 'list', value: {} }];
  const requests = carryRequests(role, stored);
  assert.equal(requests.length, 3);
  const fake = standIn(rows);
  const outcomes = requests.slice(1).map(request => writeOutcome(request, fake.run(request.input)));
  assert.deepEqual(outcomes.map(o => o.written), [false, true]);
  assert.deepEqual(rows.map(row => row.id).sort(), ['record:setting:make-a-sample~account~main', 'record:setting:make-a-sample~film~f1']);
  assert.deepEqual(rows.find(row => row.id.endsWith('film~f1')).settings, { pace: 5 });
});
