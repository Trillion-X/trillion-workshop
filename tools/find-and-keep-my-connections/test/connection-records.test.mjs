import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionIdFromRecord, connectionMetadata, connectionOpenUrl, connectionOwner, connectionRecordRef, connectionRelations, connectionState, connectionSummaryOf, ownedConnectionRow, sharedConnectionOfferId, sharedConnectionPage, sharedConnectionRecordRef, sharedConnectionRow } from '../src/connection-records.mjs';

const owned = { connection_id: 'service_connection:calendar:one', service: 'Calendar', vendor: 'calendar', account_label: 'Work', status: 'connected', can_send: true, connected_at: '2026-10-12T08:00:00Z' };
const sharedCopy = (name = 'Alex', relay = 'relay_alex') => ({ kind: 'connection', body: { ...owned, owner: { id: 'forged', label: 'You', mine: true } }, provenance: { from: name, owner_ref: relay, read_at: '2026-10-12T08:01:00Z' } });

test('canonical record references preserve arbitrary account ids and reject aliases or malformed ids', () => {
  const id = 'service_connection:service/account?one&two%three';
  const ref = connectionRecordRef(id);
  assert.equal(ref, 'connection:service_connection%3Aservice%2Faccount%3Fone%26two%25three');
  assert.equal(connectionIdFromRecord(ref), id);
  assert.equal(connectionIdFromRecord('connection:service_connection:raw'), null);
  assert.equal(connectionIdFromRecord('connection:%E0%A4'), null);
  assert.equal(connectionRecordRef('bad\naccount'), null);
  assert.equal(connectionIdFromRecord(sharedConnectionRecordRef('offer_one')), null);
  assert.equal(sharedConnectionOfferId(sharedConnectionRecordRef('offer_one')), 'offer_one');
  const url = new URL(connectionOpenUrl(ref), 'https://example.test');
  assert.equal(url.pathname, '/connections');
  assert.equal(url.searchParams.get('show_row'), ref);
  assert.equal(url.searchParams.get('show_section'), 'accounts');
});

test('listing and native metadata read the same source fields without leaking credential handles', () => {
  const item = { id: owned.connection_id, serviceName: owned.service, serviceVendor: owned.vendor, accountLabel: owned.account_label, legacyStatus: owned.status, canSend: true, connectedAt: owned.connected_at,
    credentialHandle: 'private-token', credentialHandleRefs: ['locked-secret'], resourceRefs: ['private-resource'], scopes: ['send'], grantScopes: ['mail.read'], grantScopesKnown: true, password: 'private-password' };
  const row = connectionSummaryOf(item, { lastChecked: { at: '2026-10-12', service_answered: 200, response: 'private-response' }, connectedBy: { app: 'Agent app', secret: 'private-secret' } });
  assert.deepEqual(row.grant_scopes, ['mail.read'], 'the owner listing can show provider-reported grants');
  const projected = connectionMetadata({ ...row, api_key: 'private-key' }, { owner: connectionOwner({ relay: 'relay_mine', name: 'Sam' }) });
  assert.equal(projected.record_ref, connectionRecordRef(owned.connection_id));
  assert.equal(projected.account_label, 'Work');
  assert.deepEqual(projected.last_checked, { at: '2026-10-12', service_answered: 200 });
  assert.equal(projected.can_send, undefined);
  assert.equal(projected.can_manage, undefined);
  assert.equal(projected.grant_scopes, undefined, 'shared account metadata omits private grant details');
  assert.doesNotMatch(JSON.stringify(projected), /private-|locked-secret/);
});

test('self ownership requires no generated identity and own management stays with the source', () => {
  assert.deepEqual(connectionOwner(), { id: 'self', label: 'You', mine: true });
  const row = ownedConnectionRow(owned, connectionOwner({ relay: 'relay_mine', name: 'Sam' }));
  assert.equal(row.can_manage, true);
  assert.equal(row.can_send, true);
  assert.equal(row.owner.label, 'Sam');
  assert.equal(ownedConnectionRow({ ...owned, carried_by: 'computer' }, row.owner).can_manage, false);
});

test('shared rows use authenticated ownership and offer identity, never payload permissions or source ids', () => {
  const copy = sharedCopy();
  Object.assign(copy.body, { record_ref: 'connection:private-account', can_manage: true, can_send: true, grant_scopes_known: true, grant_scopes: ['mail.read'], related: [{ record: 'record:private:meeting', title: 'Private meeting' }], token: 'private-token' });
  const row = sharedConnectionRow(copy, 'offer_one');
  assert.equal(row.record_ref, 'shared-connection:offer_one');
  assert.equal(row.connection_id, row.record_ref);
  assert.deepEqual(row.owner, { id: 'relay_alex', label: 'Alex', mine: false });
  assert.equal(row.can_manage, false);
  assert.equal(row.can_send, false);
  assert.equal(row.related, undefined);
  assert.equal(row.grant_scopes, undefined, 'a shared body cannot expose provider grants');
  assert.equal(row.status, 'connected');
  assert.doesNotMatch(JSON.stringify(row), /forged|private-account|private:meeting|Private meeting|private-token|service_connection/);
});

test('same service ids or same display names in separate owners never collapse', () => {
  const left = sharedConnectionRow(sharedCopy('Alex', 'relay_one'), 'offer_one');
  const right = sharedConnectionRow(sharedCopy('Alex', 'relay_two'), 'offer_two');
  assert.notEqual(left.record_ref, right.record_ref);
  assert.notEqual(left.owner.id, right.owner.id);
  assert.equal(left.owner.label, right.owner.label);
  assert.equal(sharedConnectionRow({ kind: 'record', body: owned }, 'offer_one'), null);
});

test('every shared read rechecks its current grant and a revoked share yields unknown, never a disconnected account', async () => {
  let allowed = true, reads = 0;
  const source = { offers: [{ kind: 'connection', offer_id: 'offer_one' }], read: async id => { reads++; assert.equal(id, 'offer_one'); if (!allowed) throw new Error('private grant revoked'); return sharedCopy(); } };
  const before = await sharedConnectionPage(source);
  assert.equal(before.connections.length, 1);
  allowed = false;
  const after = await sharedConnectionPage(source);
  assert.equal(reads, 2);
  assert.deepEqual(after.connections, []);
  assert.equal(after.unavailable, 1);
  assert.equal(after.coverage.complete, false);
  assert.equal(after.coverage.other_accounts, 'unknown');
  assert.doesNotMatch(JSON.stringify(after), /Alex|Work|disconnected|private grant/);
});

test('shared pages read only offered connection records and preserve exact continuation', async () => {
  const calls = [], offers = [{ kind: 'list', offer_id: 'other' }, ...['one', 'two', 'three'].map(id => ({ kind: 'connection', offer_id: `offer_${id}` }))];
  const read = async id => { calls.push(id); return sharedCopy(); };
  const first = await sharedConnectionPage({ offers, read, limit: 2 });
  assert.deepEqual(calls, ['offer_one', 'offer_three']);
  assert.equal(first.next, 'offer_three');
  assert.equal(first.coverage.complete, false);
  const second = await sharedConnectionPage({ offers, read, limit: 2, after: first.next });
  assert.equal(second.connections.length, 1);
  assert.equal(second.connections[0].record_ref, 'shared-connection:offer_two');
  assert.equal(second.next, null);
  assert.equal(second.coverage.complete, true);
  assert.equal(second.coverage.other_accounts, 'unknown');
});

test('relationship filtering uses the current EEAF participation index in both directions', () => {
  const ref = connectionRecordRef(owned.connection_id), calls = [];
  const values = new Map([
    ['relation:one', { subject: ref, role: 'used by', object: 'record:meeting:one' }],
    ['relation:two', { subject: 'record:task:one', role: 'uses', object: ref }],
    ['relation:wrong', { subject: 'other', role: 'private', object: 'record:private:other' }],
  ]);
  const records = { holdersOf: (id, options) => { calls.push([id, options]); return { holders: [{ id: 'relation:one', type: 'relation' }, { id: 'relation:two', type: 'relation' }, { id: 'relation:wrong', type: 'relation' }, { id: 'record:post:one', type: 'record:post', role: 'account' }], complete: false, next: 'more' }; }, read: id => values.get(id), typeOf: id => id.split(':').slice(0, 2).join(':') };
  const linked = connectionRelations(records, ref, { limit: 4 });
  assert.deepEqual(linked.related.map(row => row.record), ['record:meeting:one', 'record:task:one', 'record:post:one']);
  assert.deepEqual(linked.related.map(row => row.role), ['used by', 'uses', 'account']);
  assert.equal(linked.complete, false);
  assert.equal(linked.next, 'more');
  assert.deepEqual(calls, [[ref, { limit: 4, narrow_model: true }]]);
});

test('missing visibility and missing state never become proof of not-connected or connected', () => {
  for (const row of [{}, { status: 'unknown' }]) assert.equal(connectionState(row), 'Unknown');
  assert.equal(connectionState({ status: 'disconnected' }), 'Disconnected');
  assert.equal(connectionState({ status: 'connected' }), 'Connected');
  assert.equal(connectionState({ status: 'away' }), 'Away');
});
