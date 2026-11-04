import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleNetworkRequest } from '../src/person-network.mjs';

test('a person detail waits for the Network listing before reaching its owner store', async () => {
  const refs = [];
  const person = {
    relay: () => 'asker',
    ctx: { id: { toString: () => 'asker-ref' } },
    network: () => ({ publicPerson: async () => ({ relay: 'receiver', person_ref: 'receiver-ref', name: 'Receiver', handle: 'receiver' }) }),
    env: { PERSON: { idFromString: ref => { refs.push(ref); return ref; }, get: () => ({ publicNetworkProfile: async () => ({ ais: [{ agent_id: 'helper', pingable: true }] }) }) } },
  };
  const response = await handleNetworkRequest(person, new Request('https://person/network/person?relay=receiver'));
  assert.equal(response.status, 200);
  assert.deepEqual(refs, ['receiver-ref']);
  assert.deepEqual(await response.json(), { relay: 'receiver', name: 'Receiver', handle: 'receiver', ais: [{ agent_id: 'helper', pingable: true }], yours: false });
});
