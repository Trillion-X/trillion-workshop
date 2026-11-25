// tools/keep-a-postgres-database-on-a-computer/test/pause-a-databases-writers.test.mjs
//
// The apply request that pauses a moving database's writers, and resumes them, from the move's pointers row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pauseRequest } from '../do-work/pause-a-databases-writers.mjs';

const commit = 'a'.repeat(40);
const kept = { path: '/etc/example-postgres/in-every-new-database.sql', text: 'select 1;\n', then: [['true']] };
const runs = {
  units: [{ unit: 'example-postgres.service', user: 'postgres', hba_file: '/etc/example-postgres/pg_hba.conf', environment: ['PGDATA=/var/lib/example', 'PGHOST=/run/postgresql'], files: [kept] }],
  absent: ['/etc/example-old.conf'],
};
const pointer = {
  id: 'pointer:example-databases-moved',
  check_result: JSON.stringify({
    state: 'copied',
    pause: {
      computer: 'example-old-server', unit: 'example-postgres.service',
      run: ['REVOKE CONNECT ON DATABASE example_db FROM example_db', "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'example_db' AND usename <> 'postgres';"],
      reverse: ['GRANT CONNECT ON DATABASE example_db TO example_db'],
    },
  }),
};
const path = '/etc/example-postgres/writes-paused-example-databases-moved.sql';

test('pause writes the run statements as a file the server runs with psql, keeping the unit\'s other files', () => {
  const request = pauseRequest({ phase: 'pause', runs, pointer, commit });
  assert.equal(request.computer, 'example-old-server');
  assert.equal(request.workshop_commit, commit);
  assert.equal(request.edits.length, 1);
  const [edit] = request.edits;
  assert.equal(edit.at, 'runs.units[unit=example-postgres.service].files');
  assert.deepEqual(edit.from, [kept]);
  assert.deepEqual(edit.to[0], kept);
  assert.equal(edit.to[1].path, path);
  assert.match(edit.to[1].text, /^-- Written from this computer's row by pause-a-databases-writers \(pause\), from pointer:example-databases-moved/);
  assert.ok(edit.to[1].text.endsWith("REVOKE CONNECT ON DATABASE example_db FROM example_db;\nSELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'example_db' AND usename <> 'postgres';\n"));
  assert.deepEqual(edit.to[1].then, [['sh', '-c', `runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -h /run/postgresql -d postgres < ${path} && logger -t pause-a-databases-writers 'pause pointer:example-databases-moved'`]]);
});

test('resume writes the reverse statements over the same file, so the change runs them', () => {
  const paused = pauseRequest({ phase: 'pause', runs, pointer, commit }).edits[0].to;
  const request = pauseRequest({ phase: 'resume', runs: { ...runs, units: [{ ...runs.units[0], files: paused }] }, pointer, commit });
  const [edit] = request.edits;
  assert.deepEqual(edit.from, paused);
  assert.equal(edit.to.length, 2);
  assert.equal(edit.to[1].path, path);
  assert.ok(edit.to[1].text.endsWith('GRANT CONNECT ON DATABASE example_db TO example_db;\n'));
  assert.match(edit.to[1].then[0][2], /'resume pointer:example-databases-moved'$/);
});

test('a pause file the row lists as absent is taken out of absent in the same request', () => {
  const request = pauseRequest({ phase: 'pause', runs: { ...runs, absent: [...runs.absent, path] }, pointer, commit });
  assert.deepEqual(request.edits[1], { at: 'runs.absent', from: [...runs.absent, path], to: runs.absent });
});

test('it refuses a psql command, two statements in one, a missing reverse, an unknown unit and a short commit', () => {
  const withPause = pause => ({ ...pointer, check_result: { pause: { computer: 'example-old-server', unit: 'example-postgres.service', run: ['select 1'], reverse: ['select 2'], ...pause } } });
  assert.throws(() => pauseRequest({ phase: 'pause', runs, pointer: withPause({ run: ['\\! id'] }), commit }), /psql command/);
  assert.throws(() => pauseRequest({ phase: 'pause', runs, pointer: withPause({ run: ['select 1; select 2'] }), commit }), /more than one SQL statement/);
  assert.throws(() => pauseRequest({ phase: 'pause', runs, pointer: withPause({ reverse: [] }), commit }), /reverse is a list of SQL statements/);
  assert.throws(() => pauseRequest({ phase: 'pause', runs, pointer: withPause({ unit: 'other.service' }), commit }), /runs no other\.service/);
  assert.throws(() => pauseRequest({ phase: 'pause', runs, pointer, commit: 'abc' }), /full commit id/);
  assert.throws(() => pauseRequest({ phase: 'stop', runs, pointer, commit }), /pause or resume/);
});
