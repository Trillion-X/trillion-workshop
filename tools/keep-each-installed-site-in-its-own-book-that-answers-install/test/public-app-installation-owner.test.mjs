// One public app installation as its own owner (src/public-app-installation-owner.mjs), driven on its own SQLite the way
// its record book drives it: install and read it back, take it offline and back, and import a retiring store's row only
// for the operator import, verified by its BLAKE3 identity, never overwriting a held installation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { publicAppInstallationOwner, publicAppInstallationRowIdentity } from '../src/public-app-installation-owner.mjs';
import { checkedPublicAppDefinition } from '../../edit-a-site-visually/src/public-app-definition.mjs';

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OPERATOR = { claims: { sign_in: 'service:operator-import' } };
const definition = checkedPublicAppDefinition({
  id: 'client-intake', version: 'v-test', actions: [
    { id: 'send-inquiry', record_kind: 'client.inquiry', fields: [{ id: 'email', type: 'email', required: true }] },
  ],
});
const sqlite = () => {
  const db = new DatabaseSync(':memory:');
  return { db, sql: { exec(query, ...values) {
    const statement = db.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) return { toArray: () => statement.all(...values) };
    statement.run(...values);
    return { toArray: () => [] };
  } } };
};
const install = (owner, overrides = {}) => owner.handle('install', {
  installation_id: ID, definition, context: { kind: 'private', id: 'person-1' }, installed_by: 'person-1', live: true, ...overrides,
});
const exported = db => db.prepare('SELECT * FROM public_app_installations WHERE id = ?').get(ID);

test('an installation is installed once, read back, and answers the same install again', () => {
  const { db, sql } = sqlite();
  const owner = publicAppInstallationOwner({ sql, installationId: ID });
  const made = install(owner);
  assert.equal(made.installation_id, ID);
  assert.equal(made.status, 'active');
  assert.equal(owner.handle('read').installed_by, 'person-1');
  assert.deepEqual(install(owner), owner.handle('read'));
  assert.throws(() => install(owner, { installed_by: 'person-2' }), /already in use/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM public_app_installations').get().n, 1);
});

test('taking an installation offline and back online is its own state, read back from its row', () => {
  const owner = publicAppInstallationOwner({ sql: sqlite().sql, installationId: ID });
  install(owner);
  assert.equal(owner.handle('setLive', { live: false }).status, 'ended');
  assert.equal(owner.handle('read').status, 'ended');
  assert.equal(owner.handle('setLive', { live: true }).status, 'active');
  assert.equal(owner.handle('read').ended_at, null);
});

test('an operator-import row is written only for the operator import, and only if its identity matches', () => {
  const { db, sql } = sqlite();
  const owner = publicAppInstallationOwner({ sql, installationId: ID });
  const row = { id: ID, definition: JSON.stringify(definition), context_kind: 'private', context_id: 'person-1', installed_by: 'person-1', status: 'ended', installed_at: '2026-10-01T00:00:00.000Z', ended_at: '2026-10-02T00:00:00.000Z' };
  const identity = publicAppInstallationRowIdentity(row);
  assert.throws(() => owner.handle('importRow', { row, identity }, { claims: { sign_in: 'session:1' } }), error => error.status === 403);
  assert.throws(() => owner.handle('importRow', { row, identity: 'f'.repeat(64) }, OPERATOR), error => error.status === 400 && error.code === 'row_identity_mismatch');
  assert.throws(() => owner.handle('importRow', { row: { ...row, id: 'b'.repeat(32) }, identity: publicAppInstallationRowIdentity({ ...row, id: 'b'.repeat(32) }) }, OPERATOR), error => error.status === 400);
  assert.deepEqual(owner.handle('importRow', { row, identity }, OPERATOR), { installation_id: ID, identical: false });
  assert.equal(exported(db).status, 'ended');
  assert.deepEqual(owner.handle('importRow', { row, identity }, OPERATOR), { installation_id: ID, identical: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM public_app_installations').get().n, 1);
});

test('an import never overwrites a different installation already held here', () => {
  const { db, sql } = sqlite();
  const owner = publicAppInstallationOwner({ sql, installationId: ID });
  install(owner);
  const row = { ...exported(db), definition: JSON.stringify(definition), status: 'ended', installed_at: '2026-10-09T00:00:00.000Z', ended_at: null };
  const identity = publicAppInstallationRowIdentity(row);
  assert.throws(() => owner.handle('importRow', { row, identity }, OPERATOR), error => error.status === 409 && error.held[0] === ID);
  assert.equal(owner.handle('read').status, 'active');
});

test('an owner names only its own installation and answers only its operations', () => {
  const owner = publicAppInstallationOwner({ sql: sqlite().sql, installationId: ID });
  assert.throws(() => install(owner, { installation_id: 'b'.repeat(32) }), error => error.status === 400);
  assert.throws(() => owner.handle('delete'), error => error.status === 404);
  assert.throws(() => publicAppInstallationOwner({ sql: sqlite().sql, installationId: 'short' }), error => error.status === 400);
});
