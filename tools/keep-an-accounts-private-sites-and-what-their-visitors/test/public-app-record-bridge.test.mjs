import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { eeafStore } from '../../keep-and-wake-ai-sessions-on-this-computer/parts/eeaf/do-work/eeaf-sqlite-store.mjs';
import { checkedPublicAppDefinition } from '../../edit-a-site-visually/src/public-app-definition.mjs';
import { privatePublicAppRecords, recordPrivatePublicAppAction, recordSpacePublicAppAction, spacePublicAppRecords } from '../src/public-app-record-bridge.mjs';
import { yourRecordsStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/your-records.mjs';

// The local host's SQLite (src/local-store.mjs): its cursors iterate row by row as a Durable Object's do, which the
// record store reads since 38324da39; the stand-in this file kept answered toArray only.
const sqlite = () => sqliteHost(':memory:');

const definition = checkedPublicAppDefinition({
  id: 'client-intake', version: 'v-test', actions: [
    { id: 'send-inquiry', record_kind: 'client.inquiry', fields: [{ id: 'email', type: 'email', required: true }, { id: 'note', type: 'text' }] },
    { id: 'book-call', record_kind: 'client.booking', fields: [{ id: 'email', type: 'email', required: true }, { id: 'note', type: 'text' }] },
  ],
});
const input = (overrides = {}) => ({
  installation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', action_id: 'send-inquiry',
  fields: { email: 'ana@example.test', note: 'Tuesday works' }, request_key: 'visitor-2026-10-01-ana', ...overrides,
});

test('private submissions are the generic EEAF record and retry identity is that same row', () => {
  const store = sqlite();
  const eeaf = eeafStore(store.sql, { transaction: store.transaction, hash: value => bytesToHex(blake3(value)) });
  const records = yourRecordsStore(eeaf);
  const installation = { installation_id: input().installation_id, definition, context: { kind: 'private', id: 'person-a' }, installed_by: 'person-a', status: 'active' };
  let timestamp = 0;
  const options = { installation, eeaf, transaction: store.transaction, now: () => `2026-10-01T00:00:0${++timestamp}.000Z` };

  const first = recordPrivatePublicAppAction({ ...options, input: input() });
  const repeat = recordPrivatePublicAppAction({ ...options, input: input() });
  assert.equal(first.record_id, repeat.record_id);
  assert.equal(first.already_received, false);
  assert.equal(repeat.already_received, true);
  assert.deepEqual(records.read(['client.inquiry']).map(row => ({ email: row.email, note: row.note })), [{ email: 'ana@example.test', note: 'Tuesday works' }]);
  assert.deepEqual(eeaf.find({ words: ['ana'], fields: [['email']] }).map(row => row.id), [`record:client.inquiry:${first.record_id}`],
    'ordinary record search reaches the visitor response under its canonical address');
  assert.deepEqual(privatePublicAppRecords({ installation, eeaf }).records.map(row => row.record_id), [first.record_id]);
  assert.equal(eeaf.ids('record:client.inquiry').length, 1);
  assert.throws(() => recordPrivatePublicAppAction({ ...options, input: input({ fields: { email: 'different@example.test', note: 'Tuesday works' } }) }), /different response/);
  assert.throws(() => recordPrivatePublicAppAction({ ...options, input: input({ action_id: 'book-call', fields: { email: 'ana@example.test', note: 'Tuesday works' } }) }), /different response/);
  assert.equal(yourRecordsStore(eeaf).read(['client.inquiry']).length, 1, 'dotted kinds are accepted by the generic records reader');
});

test('Space submissions are canonical Space items, notify once, and read requires current membership', async () => {
  const store = sqlite();
  store.sql.exec('CREATE TABLE space_items (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT, body TEXT, origin TEXT NOT NULL, contributed_by TEXT NOT NULL, source_ref TEXT, about TEXT NOT NULL, added_at TEXT NOT NULL, withdrawn_at TEXT, withdrawn_by TEXT)');
  store.sql.exec('CREATE UNIQUE INDEX space_items_one_source ON space_items (space_id, contributed_by, source_ref) WHERE source_ref IS NOT NULL');
  const submission = input();
  const installation = { installation_id: submission.installation_id, definition, context: { kind: 'space', id: 'space-a' }, installed_by: 'departed-installer', status: 'active' };
  let notifications = 0;
  const options = {
    installation, input: submission, sql: store.sql, transaction: store.transaction,
    afterWrite: ({ space_id, item_id }) => { assert.equal(space_id, 'space-a'); assert.ok(item_id); notifications += 1; },
    now: () => '2026-10-01T00:00:00.000Z',
  };
  const first = recordSpacePublicAppAction(options);
  const repeat = recordSpacePublicAppAction(options);
  assert.equal(repeat.already_received, true);
  assert.equal(repeat.record_id, first.record_id);
  assert.equal(notifications, 1);
  assert.equal(store.sql.exec('SELECT id FROM space_items').toArray().length, 1);
  assert.deepEqual(JSON.parse(store.sql.exec('SELECT body FROM space_items').toArray()[0].body).email, 'ana@example.test');
  assert.deepEqual((await spacePublicAppRecords({
    installation, sql: store.sql, relay: 'current-member', authorizeRead: async (spaceId, relay) => {
      assert.deepEqual([spaceId, relay], ['space-a', 'current-member']);
    },
  })).records.map(row => row.record_id), [first.record_id]);
  await assert.rejects(spacePublicAppRecords({ installation, sql: store.sql }), /current pursuit member check/);
  await assert.rejects(spacePublicAppRecords({ installation, sql: store.sql, relay: 'former-member', authorizeRead: async () => { throw new Error('not a current member'); } }), /not a current member/);
  assert.throws(() => recordSpacePublicAppAction({ ...options, input: input({ fields: { email: 'different@example.test', note: 'Tuesday works' } }) }), /different response/);
  assert.equal(store.sql.exec('SELECT id FROM space_items').toArray().length, 1);
});

test('shop interest keeps contact choice and app attribution in its Space record', async () => {
  const store = sqlite();
  store.sql.exec('CREATE TABLE space_items (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT, body TEXT, origin TEXT NOT NULL, contributed_by TEXT NOT NULL, source_ref TEXT, about TEXT NOT NULL, added_at TEXT NOT NULL, withdrawn_at TEXT)');
  store.sql.exec('CREATE UNIQUE INDEX space_items_one_source ON space_items (space_id, contributed_by, source_ref) WHERE source_ref IS NOT NULL');
  const installation = {
    installation_id: 'cccccccccccccccccccccccccccccccc',
    definition: checkedPublicAppDefinition({ id: 'shop-example', version: 'v-test', actions: [{
      id: 'hear-from-us', record_kind: 'customer-interest', fields: [
        { id: 'email', type: 'email', required: true }, { id: 'contact-ok', type: 'boolean', required: true },
      ],
    }] }),
    context: { kind: 'space', id: 'merchant-space' }, installed_by: 'merchant-owner', status: 'active',
  };
  const saved = recordSpacePublicAppAction({ installation, sql: store.sql, transaction: store.transaction,
    input: { installation_id: installation.installation_id, action_id: 'hear-from-us',
      fields: { email: 'visitor@example.test', 'contact-ok': true }, request_key: 'shop-interest:proof-visitor-1' },
    now: () => '2026-10-04T00:00:00.000Z',
  });
  const row = store.sql.exec('SELECT space_id, kind, body FROM space_items').toArray()[0];
  const body = JSON.parse(row.body);
  assert.equal(row.space_id, 'merchant-space');
  assert.equal(row.kind, 'customer-interest');
  assert.equal(body['contact-ok'], true);
  assert.equal(body._public_app.record_id, saved.record_id);
  assert.equal(body._public_app.installation_id, installation.installation_id);
  assert.equal(body._public_app.action_id, 'hear-from-us');
});

test('an ended installation cannot accept a visitor response', () => {
  const store = sqlite();
  const eeaf = eeafStore(store.sql, { transaction: store.transaction, hash: value => bytesToHex(blake3(value)) });
  const installation = { installation_id: input().installation_id, definition, context: { kind: 'private', id: 'person-a' }, installed_by: 'person-a', status: 'ended' };
  assert.throws(() => recordPrivatePublicAppAction({ installation, input: input(), eeaf, transaction: store.transaction }), /not accepting responses/);
  assert.equal(eeaf.ids('record:client.inquiry').length, 0);
});
