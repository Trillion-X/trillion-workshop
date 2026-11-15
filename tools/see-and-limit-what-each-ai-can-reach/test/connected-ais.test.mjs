import test from 'node:test';
import assert from 'node:assert/strict';
import { connectedAis, aiConnection, clientsOfAis, connectedAiNames } from '../read-data/connected-ais.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';

test('current native sign-ins join every page of the account AI list, including legacy client introductions', async t => {
  const legacy = `key:oauth-${makeHashCodeHexFromBytes(new TextEncoder().encode('client-one')).slice(3, 27)}`;
  const ais = [
    { id: 'ai:first', label: 'First', order: 1, sign_ins: ['grant:g1'] },
    { id: 'ai:legacy', label: 'Legacy', order: 2, sign_ins: [legacy] },
    { id: 'ai:shared', label: 'Second on key', sign_ins: ['key:k1'] },
    { id: 'ai:key', label: 'Key AI', sign_ins: ['key:k1'] },
    { id: 'ai:expired', label: 'Expired', sign_ins: ['key:expired'] },
    { id: 'ai:ended', label: 'Ended', sign_ins: ['grant:ended'] },
    { id: 'ai:program', label: 'Trillion drive keeper', sign_ins: ['key:k1'] },
  ];
  const server = await startFakeDoor({ rights: [{ kind: 'ai', operations: ['records:list'] }], pageCut: 1,
    records: ais.map(({ id, ...value }) => ({ id, type: 'ai', value: { kind: 'chat', ...value } })) });
  t.after(() => server.close());
  const called = [];
  const host = { door: openRecordsDoor({ descriptor: server.descriptor }), now: () => 100,
    call: async (address, method, input) => {
      called.push({ address, method, input });
      if (method === 'sign-in:apps') return { apps: [{ id: 'g1', client_id: 'client-one' }, { id: 'native', client_id: 'phone' }] };
      if (method === 'sign-in:keys') return { keys: [{ id: 'k1', expires_at: 0 }, { id: 'expired', expires_at: 99 }] };
      throw Error('undeclared operation');
    } };
  const found = await connectedAis(host);
  assert.deepEqual(found.connected.map(ai => ai.label), ['First', 'Legacy', 'Key AI', 'Second on key']);
  assert.equal(server.calls.filter(call => call.method === 'records:list').length, ais.length);
  assert.ok(called.every(call => call.address === '@sign-in' && Object.keys(call.input).length === 0));
  const connection = await aiConnection(host);
  assert.equal(connection.connected, true);
  assert.deepEqual(connection.apps, ['First', 'Key AI and Second on key']);
  assert.equal(connection.app, 'First');
});

test('introduced names are deduplicated per sign-in; grants alone and failed owner reads prove no connection', async () => {
  const clients = clientsOfAis([{ label: 'One', sign_ins: ['key:k'] }, { label: 'One', sign_ins: ['key:k'] }, { label: 'Two', sign_ins: ['key:k'] }]);
  assert.deepEqual(connectedAiNames({ keys: [{ id: 'k' }], clients }), ['One and Two']);
  assert.deepEqual(connectedAiNames({ grants: [{ id: 'g', client_id: 'native-app' }], clients }), []);
  await assert.rejects(connectedAis({ readAis: async () => [], call: async () => ({}) }), /could not be verified/);
  await assert.rejects(connectedAis({ readAis: async () => [{ sign_ins: ['grant:undefined'] }], call: async (_, method) => method === 'sign-in:apps' ? { apps: [{}] } : { keys: [] } }), /could not be verified/);
  await assert.rejects(aiConnection({ readAis: async () => [], call: async () => { throw Error('owner refused'); } }), /owner refused/);
  assert.equal(clientsOfAis([{ label: 'An AI', sign_ins: ['__proto__'] }]).__proto__, 'An AI');
});
