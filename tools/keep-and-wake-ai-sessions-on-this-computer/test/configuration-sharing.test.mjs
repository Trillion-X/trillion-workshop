// Ported from old trillion test/configuration-sharing.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. Two of its tests have a running owner and are kept:
//   - "actual receiver link and offer refusals stay 403 while unexpected storage failures stay 503": the HTTP boundary
//     is this tool's src/configurations.mjs handleConfigurationsRequest. The old receiver (src/native-configurations.mjs
//     sharedConfigurations over its link index) is gone, so `shared` below refuses each of the old three paths the way
//     it did (a SharingError) and then fails as its storage did; the assertions are the old ones.
//   - "a metadata share excludes connection credentials, ...": tools/write-public-share-files read-data/shareable-copy.mjs
//     (old src/person-spaces.mjs shareableCopy), handed the connection rule of old src/space-settings.json
//     share_from_private (the same rule trillion-apps web/src/space-settings.json ships), as its callers hand theirs.
// Left out: the eleven tests of the record-sharing owner's methods (old src/record-sharing.mjs readConfigurationShare,
// editConfigurationShare, configurationShareRequest, admittedGrant, linkConditionHolds, releaseRecord, readSharedWithMe,
// lifted out of its source text). Searched the three repos for those names, record-sharing.mjs, sharedConfigurations
// and configuration_share_denied: only this tool's configurations.mjs boundary, record-sharing.json DATA
// (decide-when-things-show, trillion-apps) and trillion-apps screens that read the answer; no running code admits a
// configuration link, edits through one or releases a shared record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleConfigurationsRequest } from '../src/configurations.mjs';
import { shareableCopy as copyBy } from '../../write-public-share-files/read-data/shareable-copy.mjs';

// Old src/space-settings.json share_from_private.connection, at the tag.
const CONNECTION_RULE = { connection: { title: ['account_label'], fields: ['service', 'vendor', 'account_label', 'status', 'connected_at', 'last_checked', 'connected_by', 'owner'],
  nested: { owner: { fields: ['id', 'label'] }, last_checked: { fields: ['at', 'service_answered'] } } } };
const shareableCopy = (type, id, value, shape) => copyBy(type, id, value, shape, CONNECTION_RULE);
// The old receiver's refusal: its own error class, named SharingError, as the boundary reads it.
class SharingError extends Error { constructor(message) { super(message); this.name = 'SharingError'; } }

test('actual receiver link and offer refusals stay403 while unexpected storage failures stay503', async () => {
  // The receiver: a link code that is not one, a link no index names, and an offer of another kind are refused; then its
  // storage fails.
  let storage = async () => null;
  const refuse = async () => { await storage(); throw new SharingError('This configuration is not shared with you.'); };
  const shared = { read: refuse, readOffer: refuse, edit: refuse, list: refuse };
  for (const path of ['/configurations/shared/invalid!', '/configurations/shared/missing', '/configurations/offers/wrong-kind']) {
    const answer = await handleConfigurationsRequest({}, new Request(`https://person${path}`), shared);
    assert.equal(answer.status, 403, path);
    assert.equal((await answer.json()).code, 'configuration_share_denied', path);
  }
  storage = async () => { throw new Error('Internal durable storage details'); };
  const answer = await handleConfigurationsRequest({}, new Request('https://person/configurations/shared/missing'), shared);
  assert.equal(answer.status, 503);
  const body = await answer.json();
  assert.equal(body.code, 'configuration_unavailable');
  assert.doesNotMatch(JSON.stringify(body), /Internal durable storage details/);
});

test('a metadata share excludes connection credentials, private source refs and linked private records', () => {
  const copy = shareableCopy('connection', 'connection:private-source', { service: 'Calendar', vendor: 'calendar', account_label: 'Work', owner: { id: 'relay_owner', label: 'Owner', mine: true, private_key: 'secret' },
    can_send: true, can_manage: true, connection_id: 'private-source', record_ref: 'connection:private-source', related: ['record:meeting:private'], credentialHandle: 'private-token', last_checked: { at: '2026-10-12', service_answered: 200, response: 'private-response' } });
  assert.equal(copy.body.account_label, 'Work');
  assert.deepEqual(copy.body.owner, { id: 'relay_owner', label: 'Owner' });
  assert.doesNotMatch(JSON.stringify(copy.body), /secret|private|can_send|can_manage|mine/);
});
