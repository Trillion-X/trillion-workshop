// Characterize the exact original orchestration, using synthetic admitted joins and a proven-address reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { invitationArrivals } from '../tools/invite-friends-by-email/read-data/invites-on-arrival.mjs';
async function sourceOwner(bindings) {
  const name = `heldArrival${crypto.randomUUID().replaceAll('-', '')}`;
  globalThis[name] = bindings;
  try {
    const source = readFileSync(new URL('../ports/source-baselines/invite-friends-by-email/invites-on-arrival.mjs.held', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
    return await import(`data:text/javascript;base64,${Buffer.from(`const {${Object.keys(bindings).join(',')}} = globalThis.${name};\n${source}`).toString('base64')}`);
  } finally { delete globalThis[name]; }
}
function fixture({ email = 'cy@example.com', claims = null } = {}) {
  const calls = [], facts = new Map();
  const network = {
    joinWithInvite: async input => { calls.push(['legacy-link', input]); throw new Error('Legacy admission forbidden in this test'); },
    joinMatchedInvite: async input => { calls.push(['legacy-address', input]); throw new Error('Legacy admission forbidden in this test'); },
    rememberAddresses: async input => { calls.push(['addresses', input]); return { records: [{ record: { invite_id: 'synthetic-invite' } }] }; },
  };
  const person = { network: () => network, relay: () => 'relay-cy', ctx: { id: { toString: () => 'owner-cy' } }, env: { APP_KV: {} }, fact: name => facts.get(name), setFact: (name, value) => facts.set(name, value) };
  const bindings = {
    signInMethodsOf: async (_kv, user) => { calls.push(['proven', user]); return { email: email ? { address: email } : null }; },
    executeNativeSharedInvitation: async input => { calls.push(['link', input]); return { space_id: 'space-link' }; },
    joinAdmittedAddressedInvitation: async input => { calls.push(['matched', input]); return { space_id: 'space-email' }; },
  };
  return { calls, facts, network, person, bindings, input: { userId: 'cy', claims: claims ?? { sign_in: { id: 'synthetic' } }, code: 'synthetic-code' } };
}
for (const [kind, makeOwner] of [['source', f => sourceOwner(f.bindings)], ['port', f => invitationArrivals(f.bindings)]]) {
test(kind + ' held arrival joins link first and only then the proven address; preserves claims and recorder', async () => {
  const f = fixture(), owner = await makeOwner(f);
  const recorder = { synthetic: true };
  assert.deepEqual(await owner.joinInvitesOnArrival(f.person, { ...f.input, recorder }), { joined: ['space-link', 'space-email'] });
  assert.deepEqual(f.calls.map(call => call[0]), ['link', 'proven', 'addresses', 'matched']);
  assert.equal(f.calls[0][1].claims, f.input.claims);
  assert.equal(f.calls[0][1].recorder, recorder);
  assert.equal(f.calls[0][1].operation, 'joinWithInvite');
  assert.deepEqual(f.calls[2][1].addresses, ['cy@example.com']);
  assert.equal(f.calls[3][1].invite_id, 'synthetic-invite');
  assert.deepEqual((await owner.arrivalsOf(f.person)).map(row => [row.kind, row.space_id]), [['invite-to-email', 'space-email'], ['invite-link', 'space-link']]);
});
test(kind + ' held arrival refuses to discover invitations without proven email or without an account', async () => {
  for (const userId of ['cy', null]) {
    const f = fixture({ email: null }), owner = await makeOwner(f);
    assert.deepEqual(await owner.joinInvitesOnArrival(f.person, { ...f.input, userId, code: null }), { joined: [] });
    assert.equal(f.calls.some(call => ['addresses', 'matched'].includes(call[0])), false);
  }
});
test(kind + ' held arrival keeps a joined link when proven-address discovery fails', async () => {
  const f = fixture();
  f.bindings.signInMethodsOf = async () => { throw new Error('Synthetic proven-email outage'); };
  const owner = await makeOwner(f);
  assert.deepEqual(await owner.joinInvitesOnArrival(f.person, f.input), { joined: ['space-link'] });
  assert.deepEqual(f.calls.map(call => call[0]), ['link']);
  assert.equal((await owner.arrivalsOf(f.person)).length, 1);
});
test(kind + ' held arrival skips rejected link and address joins without rejecting sign-in', async () => {
  const f = fixture();
  f.bindings.executeNativeSharedInvitation = async () => { throw new Error('Synthetic expired link'); };
  f.bindings.joinAdmittedAddressedInvitation = async () => { throw new Error('Synthetic space refusal'); };
  const owner = await makeOwner(f);
  assert.deepEqual(await owner.joinInvitesOnArrival(f.person, f.input), { joined: [] });
  assert.deepEqual(await owner.arrivalsOf(f.person), []);
});
test(kind + ' held arrival deduplicates joined spaces; already-member never appends and history keeps fifty', async () => {
  const f = fixture();
  f.facts.set('arrivals', Array.from({ length: 50 }, (_, index) => ({ space_id: `old-${index}` })));
  f.bindings.joinAdmittedAddressedInvitation = async () => ({ space_id: 'space-link', already_member: true });
  const owner = await makeOwner(f);
  assert.deepEqual(await owner.joinInvitesOnArrival(f.person, f.input), { joined: ['space-link'] });
  const history = await owner.arrivalsOf(f.person);
  assert.equal(history.length, 50);
  assert.equal(history[0].space_id, 'space-link');
  assert.equal(history[49].space_id, 'old-48');
});

}

test('port refuses unsigned arrival before any discovery or join', async () => { const f = fixture(); const owner = invitationArrivals(f.bindings); assert.deepEqual(await owner.joinInvitesOnArrival(f.person, { ...f.input, claims: null }), { joined: [] }); assert.deepEqual(f.calls, []); });

test('port awaits durable arrival reads and writes before returning joined spaces', async () => {
  const f = fixture(), stored = [];
  let saved = false;
  f.person.fact = async () => { await Promise.resolve(); return structuredClone(stored); };
  f.person.setFact = async (_kind, value) => { await Promise.resolve(); stored.splice(0, stored.length, ...value); saved = true; };
  const owner = invitationArrivals(f.bindings);
  assert.deepEqual(await owner.joinInvitesOnArrival(f.person, f.input), { joined: ['space-link', 'space-email'] });
  assert.equal(saved, true);
  assert.equal((await owner.arrivalsOf(f.person)).length, 2);
});
