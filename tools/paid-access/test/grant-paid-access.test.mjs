// tool:grant-paid-access-to-people runs as its row runs it, against the stand-in records door with exactly the row's
// rights: a grant it writes is then held by heldAccess (the one answer every gate asks), asking again writes nothing,
// a window the reader would never hold is refused with why, and a revoke ends the grant. Every value here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import { heldAccess } from '../read-data/who-holds-access.mjs';
import { grantId, revokeId } from '../read-data/access-grants.mjs';

const grant = rowOf(rows, 'tool:grant-paid-access-to-people');
const NOW = Date.UTC(2026, 5, 1);
const DAY = 86_400_000;
const ANA = 'ana@example.com';
const BO = 'bo@example.com';

const valuesOf = kept => kept.filter(item => item.type === 'access-grant').map(item => item.value);
const heldBy = (kept, subject) => heldAccess({ subject, nowMs: NOW, grants: valuesOf(kept) }).held_access_refs;

test('a written grant is held, in exactly the shape the reader reads, and a second run writes nothing', async () => {
  const input = { grants: [
    { subject: ANA, access_ref: 'access:course-a' },
    { subject: BO, access_ref: 'access:course-a', grant_ref: 'grant:imported-1', valid_from_ms: NOW - DAY, expires_at_ms: NOW + DAY, note: 'moved over' },
  ] };
  const first = await answerOf(grant, input);
  assert.equal(first.status, 0, first.error);
  assert.deepEqual(first.result, { written: 2, already: 0, refused: [] });
  assert.deepEqual(first.kept.map(item => item.type), ['access-grant', 'access-grant']);
  assert.deepEqual(first.kept.find(item => item.id === grantId(ANA, 'grant:access:course-a')).value,
    { kind: 'license_access', subject: ANA, object: 'access:course-a', material: { grant_ref: 'grant:access:course-a' } });
  assert.deepEqual(first.kept.find(item => item.id === grantId(BO, 'grant:imported-1')).value,
    { kind: 'license_access', subject: BO, object: 'access:course-a', material: { grant_ref: 'grant:imported-1', valid_from_ms: NOW - DAY, expires_at_ms: NOW + DAY }, note: 'moved over' });
  assert.deepEqual([heldBy(first.kept, ANA), heldBy(first.kept, BO), heldBy(first.kept, 'cy@example.com')], [['access:course-a'], ['access:course-a'], []]);

  const second = await answerOf(grant, input, { records: first.kept });
  assert.equal(second.status, 0, second.error);
  assert.deepEqual(second.result, { written: 0, already: 2, refused: [] });
  assert.deepEqual(second.kept, first.kept, 'nothing new is kept');
  assert.ok(!second.calls.some(call => call.method === 'records:write'), 'the second run does not write');
});

test('a window the reader would never hold is refused with why, and nothing is written for it', async () => {
  const answer = await answerOf(grant, { grants: [
    { subject: ANA, access_ref: 'access:course-a', expires_at_ms: NOW + DAY },
    { subject: ANA, access_ref: 'access:course-b', valid_from_ms: NOW, expires_at_ms: NOW },
    { subject: ANA, access_ref: 'access:course-c', valid_from_ms: NOW - DAY, expires_at_ms: 1.5 },
    { subject: '', access_ref: 'access:course-d' },
    { subject: ANA, access_ref: ' ' },
    { subject: ANA, access_ref: 'access:course-e', valid_from_ms: NOW - DAY, expires_at_ms: NOW + DAY },
  ] });
  assert.equal(answer.status, 0, answer.error);
  assert.equal(answer.result.written, 1);
  assert.deepEqual(answer.result.refused.map(item => item.index), [0, 1, 2, 3, 4]);
  assert.match(answer.result.refused[0].reason, /both valid_from_ms and expires_at_ms/);
  assert.match(answer.result.refused[1].reason, /must be after valid_from_ms/);
  assert.match(answer.result.refused[2].reason, /whole number/);
  assert.match(answer.result.refused[3].reason, /subject must name the person/);
  assert.match(answer.result.refused[4].reason, /access_ref must name the access/);
  assert.deepEqual(answer.kept.map(item => item.value.object), ['access:course-e']);
  assert.deepEqual(heldBy(answer.kept, ANA), ['access:course-e']);
});

test('a revoke ends the grant, stays ended, and a grant kept with other terms is refused rather than changed', async () => {
  const given = await answerOf(grant, { grants: [{ subject: ANA, access_ref: 'access:course-a' }, { subject: ANA, access_ref: 'access:course-b', grant_ref: 'grant:gift' }] });
  assert.deepEqual(heldBy(given.kept, ANA), ['access:course-a', 'access:course-b']);

  const ended = await answerOf(grant, { grants: [{ subject: BO, access_ref: 'access:course-a' }], revoke: [{ subject: ANA, grant_ref: 'grant:access:course-a' }, { subject: ANA, grant_ref: '' }] }, { records: given.kept });
  assert.equal(ended.status, 0, ended.error);
  assert.deepEqual(ended.result, { written: 2, already: 0, refused: [{ index: 2, reason: 'grant_ref must name the grant to end (a grant given without one is named "grant:" and its access ref)' }] });
  assert.deepEqual(ended.kept.find(item => item.id === revokeId(ANA, 'grant:access:course-a')).value,
    { kind: 'revoke', subject: ANA, material: { revokes_grant_ref: 'grant:access:course-a' } });
  assert.deepEqual(heldBy(ended.kept, ANA), ['access:course-b'], 'only the ended grant is gone');
  assert.deepEqual(heldBy(ended.kept, BO), ['access:course-a']);

  const again = await answerOf(grant, { grants: [{ subject: BO, access_ref: 'access:course-a' }], revoke: [{ subject: ANA, grant_ref: 'grant:access:course-a' }] }, { records: ended.kept });
  assert.deepEqual(again.result, { written: 0, already: 2, refused: [] });

  const regrant = await answerOf(grant, { grants: [{ subject: ANA, access_ref: 'access:course-a' }] }, { records: ended.kept });
  assert.equal(regrant.result.written, 0);
  assert.match(regrant.result.refused[0].reason, /stays ended; give this grant a new grant_ref/);
  assert.deepEqual(heldBy(regrant.kept, ANA), ['access:course-b']);

  const changed = await answerOf(grant, { grants: [{ subject: ANA, access_ref: 'access:course-b', grant_ref: 'grant:gift', valid_from_ms: NOW - DAY, expires_at_ms: NOW + DAY }] }, { records: ended.kept });
  assert.equal(changed.result.written, 0);
  assert.match(changed.result.refused[0].reason, /already kept with different terms/);
});

test('one request names a grant once: the same item twice is already, the same reference with other terms is refused', async () => {
  const same = { subject: ANA, access_ref: 'access:course-a' };
  const answer = await answerOf(grant, { grants: [same, { ...same }, { ...same, note: 'other terms' }] });
  assert.deepEqual(answer.result, { written: 1, already: 1, refused: [{ index: 2, reason: `an earlier item in this request gives ${grantId(ANA, 'grant:access:course-a')} different terms` }] });
});

test('a request of 256 grants is written whole, in writes small enough for the door, and a 257th item is refused', async () => {
  const many = Array.from({ length: 256 }, (_, at) => ({ subject: `member-${at}@example.com`, access_ref: 'access:course-a', note: 'x'.repeat(200) }));
  const answer = await answerOf(grant, { grants: many });
  assert.equal(answer.status, 0, answer.error);
  assert.deepEqual(answer.result, { written: 256, already: 0, refused: [] });
  const writes = answer.calls.filter(call => call.method === 'records:write');
  assert.deepEqual(writes.map(call => call.input.records.length), [100, 100, 56]);
  assert.ok(writes.every(call => JSON.stringify(call.input).length < 65_536));
  assert.ok(writes.every(call => call.input.records.every(record => record.expected === null)), 'a grant already there is never overwritten');

  const tooMany = await answerOf(grant, { grants: [...many, many[0]] });
  assert.equal(tooMany.status, 1);
  assert.match(tooMany.error, /at most 256 grants/);
  assert.deepEqual(tooMany.kept, []);
});

test('the row reads and writes only access-grant records and holds no key, network or person', () => {
  assert.deepEqual(grant.invoke.records.rights, [{ kind: 'access-grant', operations: ['records:read', 'records:write'] }]);
  assert.equal(grant.invoke.internet, false);
  assert.equal(grant.invoke.credential_mounts, undefined);
  assert.doesNotMatch(grant.maker, /trillion|bitfield/i);
});

test('a revoke with no grant is a permanent tombstone; a later grant needs a fresh reference', async () => {
  const ended = await answerOf(grant, { grants: [], revoke: [{ subject: ANA, grant_ref: 'grant:access:course-a' }] });
  assert.equal(ended.status, 0, ended.error);
  assert.deepEqual(ended.result, { written: 1, already: 0, refused: [] });
  assert.deepEqual(heldBy(ended.kept, ANA), []);

  const sameRef = await answerOf(grant, { grants: [{ subject: ANA, access_ref: 'access:course-a' }] }, { records: ended.kept });
  assert.equal(sameRef.result.written, 0);
  assert.match(sameRef.result.refused[0].reason, /stays ended; give this grant a new grant_ref/);
  assert.deepEqual(heldBy(sameRef.kept, ANA), []);

  const fresh = await answerOf(grant, { grants: [{ subject: ANA, access_ref: 'access:course-a', grant_ref: 'grant:replacement' }] }, { records: ended.kept });
  assert.deepEqual(fresh.result, { written: 1, already: 0, refused: [] });
  assert.deepEqual(heldBy(fresh.kept, ANA), ['access:course-a']);

  const empty = await answerOf(grant, { grants: [] }, { records: ended.kept });
  assert.equal(empty.status, 1);
  assert.match(empty.error, /at least one grant or revoke/);
});

test('a grant and its revoke in one request are both accepted, and the projection ends access', async () => {
  const answer = await answerOf(grant, { grants: [{ subject: ANA, access_ref: 'access:course-a' }], revoke: [{ subject: ANA, grant_ref: 'grant:access:course-a' }] });
  assert.equal(answer.status, 0, answer.error);
  assert.deepEqual(answer.result, { written: 2, already: 0, refused: [] });
  assert.deepEqual(heldBy(answer.kept, ANA), [], 'a revoke terminates the matching instance regardless of the two records being written together');
});

test('large Unicode grants batch by encoded bytes and rows under the real door cap', async () => {
  const grants = Array.from({ length: 8 }, (_, at) => ({
    subject: `客户-é-${at}`,
    access_ref: `access:课程-${at}`,
    grant_ref: `会员🎾-${at}`,
    note: '🎾'.repeat(5_000),
  }));
  const answer = await answerOf(grant, { grants }, { doorOptions: { mostRequestBytes: 65_536 } });
  assert.equal(answer.status, 0, answer.error);
  assert.deepEqual(answer.result, { written: 8, already: 0, refused: [] });
  const writes = answer.calls.filter(call => call.method === 'records:write');
  assert.ok(writes.length > 1, 'large Unicode records are split by bytes');
  assert.ok(writes.every(call => call.input.records.length <= 100));
  assert.ok(writes.every(call => call.input.records.every(record => record.expected === null)));
  assert.ok(writes.every(call => call.input.records.some(record => record.id.includes('%'))), 'Unicode identity parts are encoded in record ids');
  assert.ok(!answer.calls.some(call => Object.hasOwn(call, 'refused_bytes')), 'the records door accepted every actual request body under 64 KiB');
  for (const call of writes) {
    const wire = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_resource_operation', arguments: {
      address: '@own-records', method: call.method, request_key: call.key, input: call.input,
    } } };
    assert.ok(Buffer.byteLength(JSON.stringify(wire), 'utf8') <= 65_536, 'the complete UTF-8 door request fits the 64 KiB cap');
  }

  const oversized = await answerOf(grant, { grants: [{ subject: 'é'.repeat(10_000), access_ref: 'access:course-a' }] });
  assert.equal(oversized.status, 0, oversized.error);
  assert.deepEqual(oversized.result, { written: 0, already: 0, refused: [{ index: 0, reason: 'this access-grant record exceeds the 60000-byte write limit; shorten its subject, grant_ref or note' }] });
  assert.ok(!oversized.calls.some(call => call.method === 'records:write'));
});

test('stored grants reach the actual reader and authorization rows, and revocation closes the consumer', async () => {
  const read = rowOf(rows, 'tool:see-who-holds-paid-access');
  const check = rowOf(rows, 'tool:check-a-buyer-may-open');
  const subject = 'member@example.test', access = 'access:synthetic-member';
  const scope = {
    schema: 'addressed-expiring-value-scope/v1',
    value_ref: 'page:synthetic-event', instance_ref: 'page:synthetic-event:1',
    required_access_refs: [access],
  };
  const given = await answerOf(grant, { grants: [{ subject, access_ref: access }] });
  assert.equal(given.status, 0, given.error);
  assert.deepEqual(given.result, { written: 1, already: 0, refused: [] });
  const observed = await answerOf(read, { subject }, { records: given.kept });
  assert.equal(observed.status, 0, observed.error);
  assert.deepEqual(observed.result.held_access_refs, [access]);
  assert.ok(observed.calls.some(call => call.method === 'records:list' && call.input.type === 'access-grant'));
  assert.ok(!observed.calls.some(call => call.method === 'records:write'));
  const permitted = await answerOf(check, { subject, scope }, { records: given.kept });
  assert.equal(permitted.status, 0, permitted.error);
  assert.deepEqual(permitted.result, { authorized: true });
  const stranger = await answerOf(check, { subject: 'other@example.test', scope }, { records: given.kept });
  assert.equal(stranger.status, 0, stranger.error);
  assert.deepEqual(stranger.result, { authorized: false });
  // An independent door represents another seller's records, not a native
  // proof of grantor identity. Names alone cannot move the first door's grant.
  const anotherDoor = await answerOf(check, { subject, scope });
  assert.equal(anotherDoor.status, 0, anotherDoor.error);
  assert.deepEqual(anotherDoor.result, { authorized: false });
  const ended = await answerOf(grant, { grants: [], revoke: [{ subject, grant_ref: `grant:${access}` }] }, { records: given.kept });
  assert.equal(ended.status, 0, ended.error);
  assert.deepEqual(ended.result, { written: 1, already: 0, refused: [] });
  const after = await answerOf(read, { subject }, { records: ended.kept });
  assert.equal(after.status, 0, after.error);
  assert.deepEqual(after.result.held_access_refs, []);
  const closed = await answerOf(check, { subject, scope }, { records: ended.kept });
  assert.equal(closed.status, 0, closed.error);
  assert.deepEqual(closed.result, { authorized: false });
});

test('the authorization row reads its own records rather than caller-supplied holdings', async () => {
  const check = rowOf(rows, 'tool:check-a-buyer-may-open');
  const subject = 'member@example.test', access = 'access:synthetic-member';
  const scope = {
    schema: 'addressed-expiring-value-scope/v1',
    value_ref: 'page:synthetic-event', instance_ref: 'page:synthetic-event:1',
    required_access_refs: [access],
  };
  const answer = await answerOf(check, {
    subject, scope,
    grants: [{ kind: 'license_access', subject, object: access, material: { grant_ref: 'invented' } }],
    held_access_refs: [access], account_id: 'another-account', records_resource: '@another-records',
  });
  assert.equal(answer.status, 0, answer.error);
  assert.deepEqual(answer.result, { authorized: false });
  assert.ok(answer.calls.some(call => call.method === 'records:list' && call.input.type === 'access-grant'));
  assert.ok(!answer.calls.some(call => call.method === 'records:write'));
});

test('grant write denial propagates without creating a grant', async () => {
  const readonly = structuredClone(grant);
  readonly.invoke.records.rights = [{ kind: 'access-grant', operations: ['records:read'] }];
  const answer = await answerOf(readonly, { grants: [{ subject: 'member@example.test', access_ref: 'access:synthetic-member' }] });
  assert.equal(answer.status, 1);
  assert.deepEqual(answer.kept, []);
  assert.ok(answer.calls.some(call => call.method === 'records:write'));
});
