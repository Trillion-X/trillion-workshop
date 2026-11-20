// The caller reads the Service connections rows from the person's own store and hands them in as `connections`.
// Proved on two stores made here with made-up rows: a JSON file and a PostgreSQL database (PGlite, in memory). Each
// store answers the same rows, and the tool answers the same where-the-door-runs from either.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { seeWhereTheDoorRuns } from '../do-work/door-tools.mjs';
import { ROWS } from './door-world.mjs';

const expected = {
  current: { kind: 'public-door-placement', id: 'current', name: 'Where the public door runs', hosting_provider: 'example-cloud', hostname: 'door.example.com', server_id: null, address: null, dns_record: null, lease_file: null, unknown_because: 'Not read yet.', proof: { health: '/healthz', download: '/download/App.dmg' } },
  hosting: [['example-cloud', true], ['no-public-address', false], ['own-box', true]],
};
const summary = answer => [answer.current.hosting_provider, answer.hosting_providers.map(r => [r.id, r.move_ready])];

test('a JSON store holding the rows answers where the door runs, read by the caller and handed in', async () => {
  const dir = tempFolder(join(tmpdir(), 'see-door-json-'));
  const file = join(dir, 'service-connections.json');
  writeFileSync(file, JSON.stringify(Object.entries(ROWS).map(([name, value]) => ({ id: `record:service-connection:${name}`, type: 'record:service-connection', value }))));
  const connections = JSON.parse(readFileSync(file, 'utf8')).filter(r => r.type === 'record:service-connection').map(r => r.value);
  const answer = await seeWhereTheDoorRuns({ connections });
  assert.equal(answer.current.hostname, expected.current.hostname);
  assert.deepEqual(summary(answer), ['example-cloud', expected.hosting.map(([id, ready]) => [id, ready])]);
});

test('a PostgreSQL store (PGlite) holding the rows answers the same where the door runs', async () => {
  const db = new PGlite();
  try {
    await db.exec('create table service_connections (id text primary key, value jsonb not null)');
    for (const [name, value] of Object.entries(ROWS)) await db.query('insert into service_connections (id, value) values ($1, $2)', [`service_connection:${name}`, JSON.stringify(value)]);
    const { rows } = await db.query('select value from service_connections order by id');
    const answer = await seeWhereTheDoorRuns({ connections: rows.map(r => r.value) });
    assert.deepEqual(summary(answer), ['example-cloud', expected.hosting.map(([id, ready]) => [id, ready])]);
    assert.equal(answer.current.hostname, 'door.example.com');
  } finally {
    await db.close();
  }
});

test('the tool refuses a call that hands in no connections, and reads no store to fill them', async () => {
  await assert.rejects(seeWhereTheDoorRuns({}), /Hand in `connections`/);
});
