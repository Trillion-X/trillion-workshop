// The pure service-actor checks (layer one), on the origins rows, with a made-up key that exists only in this file.
// No actor is minted here: the proof in these tests is made by this file's own oracle, from the test key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import rows from '../src/service-actor-origins.json' with { type: 'json' };
import {
  indexRows, isServiceSignIn, serviceOriginOfClaims, serviceGateKnown, serviceGateOf, checkedScope, signedFields, serviceClaimsMinted,
} from '../do-work/service-actor-checks.mjs';

const index = indexRows(rows);
const TEST_KEY = '07'.repeat(32); // made up for this test file only
const ACCOUNT = 'account_test_1';
const TASK = `task_${'ab'.repeat(16)}`;

// The first origin that may act on a tool-run scope, so the test follows the rows rather than a name.
const toolRunOrigin = rows.origins.find(origin => origin.scopes.includes('tool-run'))?.id;

/** This file's oracle for a proof: the keyed digest of the signed fields. Not the module's mint (there is none here). */
const oracleProof = (key, account, claims) => bytesToHex(blake3(signedFields(account, claims), { key: hexToBytes(key) }));

const claimsFor = (origin, scope, extra = {}) => {
  const base = {
    sign_in: `service:${origin}`, issued_at: '2026-11-20T04:00:00.000Z', made: null, ceiling: null, approved_by: 'service',
    service_scope: { kind: scope.kind, id: scope.id }, ...extra,
  };
  return { ...base, service_proof: oracleProof(TEST_KEY, ACCOUNT, base) };
};

test('the reserved prefixes are the rows the old module named, and only those mark a service principal', () => {
  assert.deepEqual(rows.reserved_prefixes, ['service:', 'system:']);
  assert.equal(isServiceSignIn(index, 'service:automations'), true);
  assert.equal(isServiceSignIn(index, 'system:anything'), true);
  assert.equal(isServiceSignIn(index, 'person_abc'), false);
  assert.equal(isServiceSignIn(index, undefined), false);
  assert.equal(serviceOriginOfClaims({ sign_in: 'service:automations' }), 'automations');
  assert.equal(serviceOriginOfClaims({ sign_in: 'system:x' }), null, 'only the minted prefix names an origin');
});

test('a gate is known only when a scope kind of the rows names it', () => {
  assert.equal(serviceGateKnown(index, '@tool-runs'), true, 'the tool-run gate is named');
  assert.equal(serviceGateKnown(index, '@made-up-gate'), false, 'an unknown gate is refused');
});

test('a service principal opens only the gate its scope kind names, for its own scope', () => {
  const claims = claimsFor(toolRunOrigin, { kind: 'tool-run', id: TASK });
  assert.ok(serviceGateOf(index, claims, '@tool-runs'), 'the tool-run gate is open to a tool-run actor');
  assert.equal(serviceGateOf(index, claims, '@made-up-gate'), null, 'a gate the kind does not name stays shut');
});

test('a mint names an origin that exists, a scope its row allows, and the account or an id pattern', () => {
  assert.deepEqual(checkedScope(index, toolRunOrigin, ACCOUNT, { kind: 'tool-run', id: TASK }), { kind: 'tool-run', id: TASK });
  assert.throws(() => checkedScope(index, 'no-such-origin', ACCOUNT, { kind: 'tool-run', id: TASK }), (error) => error.status === 403);
  assert.throws(() => checkedScope(index, toolRunOrigin, ACCOUNT, { kind: 'tool-run', id: 'not-a-task' }), (error) => error.status === 400);
  assert.throws(() => checkedScope(index, toolRunOrigin, ACCOUNT, { kind: 'no-such-kind', id: TASK }), (error) => error.status === 403);
});

test('the proof stands only for the exact signed fields under the policy owner key', () => {
  const claims = claimsFor(toolRunOrigin, { kind: 'tool-run', id: TASK });
  assert.equal(serviceClaimsMinted(index, TEST_KEY, ACCOUNT, claims), true, 'the proof the key made stands');
  assert.equal(serviceClaimsMinted(index, '08'.repeat(32), ACCOUNT, claims), false, 'another key does not');
  assert.equal(serviceClaimsMinted(index, TEST_KEY, 'account_other', claims), false, 'another account does not');
  assert.equal(serviceClaimsMinted(index, TEST_KEY, ACCOUNT, { ...claims, service_scope: { kind: 'tool-run', id: `task_${'cd'.repeat(16)}` } }), false,
    'a changed scope does not');
  assert.equal(serviceClaimsMinted(index, TEST_KEY, ACCOUNT, { ...claims, ceiling: 'anything' }), false, 'a widened ceiling does not');
  const { service_proof: _proof, ...unproven } = claims;
  assert.equal(serviceClaimsMinted(index, TEST_KEY, ACCOUNT, unproven), false, 'claims with no proof never stand');
  assert.equal(serviceClaimsMinted(index, TEST_KEY, ACCOUNT, { ...claims, service_proof: 'zz' }), false, 'a malformed proof never stands');
});
