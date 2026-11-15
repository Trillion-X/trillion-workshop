import test from 'node:test';
import assert from 'node:assert/strict';
import { connectorsFor, findConnectors } from '../read-data/connector-finds.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';

async function cache(t, id) {
  const server = await startFakeDoor({ rights: [{ kind: 'connector-find', id, operations: ['records:read', 'records:write'] }] });
  t.after(() => server.close());
  return { server, door: openRecordsDoor({ descriptor: server.descriptor }) };
}
const source = {
  id: 'catalog', label: 'Catalog', finds: 'tool-servers', id_prefix: 'catalog:',
  entry: { id: 'id', label: 'name', job: 'about' },
  connector: { connect: ['https://tools.example/{id}'] },
  search: { url: 'https://catalog.example/find', query_param: 'q', items_field: 'items', total_field: 'total', paging: { param: 'after', next_field: 'next' } },
};

test('account last search, shared first page and one-hour expiry use scoped record doors and real catalog parsing', async t => {
  const one = await cache(t, 'connector-find:last'), two = await cache(t, 'connector-find:last'), shared = await cache(t, 'connector-find:everyone');
  let at = 1000;
  const asked = [];
  const host = door => ({ door, sharedDoor: shared.door, now: () => at,
    data: async () => ({ search_sources: [source] }), request: async url => {
      const query = new URL(url); asked.push(query);
      const name = query.searchParams.get('q') ?? 'everyone';
      return Response.json({ items: [{ id: name, name, about: 'A connector' }], total: 25, next: query.searchParams.has('after') ? null : 'next-page' });
    } });
  const first = await connectorsFor(host(one.door));
  assert.equal(first.found.connectors[0].name, 'everyone');
  assert.equal(first.found.total, 25);
  await connectorsFor(host(two.door));
  assert.equal(asked.length, 1, 'another account reuses only the public first page');
  const own = await findConnectors(host(one.door), 'cannot-select-another-account', { text: 'private search' });
  assert.equal((await connectorsFor(host(one.door))).found.connectors[0].name, 'private search');
  assert.equal((await connectorsFor(host(two.door))).found.connectors[0].name, 'everyone', 'own searches never enter the shared record');
  const next = await findConnectors(host(one.door), 'cannot-select-another-account', { text: 'private search', page: own.next_page });
  assert.equal(asked.at(-1).searchParams.get('after'), 'next-page');
  assert.equal(next.next_page, null);
  at += 3600 * 1000;
  assert.equal((await connectorsFor(host(one.door))).found.connectors[0].name, 'everyone', 'expired own and shared results are reread');
  assert.equal(shared.server.kept.get('connector-find:everyone').value.expires_at, at + 3600 * 1000);
});

test('unreached catalogs are explicit and not shared as success; unknown cache reads propagate', async t => {
  const own = await cache(t, 'connector-find:last'), shared = await cache(t, 'connector-find:everyone');
  const host = { door: own.door, sharedDoor: shared.door, data: async () => ({ search_sources: [source] }), request: async () => { throw Error('catalog unavailable'); } };
  const answer = await connectorsFor(host);
  assert.equal(answer.found.sources[0].reached, false);
  assert.equal(answer.found.total, null);
  assert.equal(shared.server.kept.size, 0);
  await assert.rejects(connectorsFor({ ...host, door: { read: async () => { throw Error('owner refused'); } } }), /owner refused/);
});
