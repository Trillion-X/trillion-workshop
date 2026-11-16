import test from 'node:test';
import assert from 'node:assert/strict';
import { connectorsFor, findConnectors } from '../read-data/connector-finds.mjs';

const source = {
  id: 'catalog', label: 'Catalog', finds: 'tool-servers', id_prefix: 'catalog:',
  entry: { id: 'id', label: 'name', job: 'about' },
  connector: { connect: ['https://tools.example/{id}'] },
  search: { url: 'https://catalog.example/find', query_param: 'q', items_field: 'items', total_field: 'total', paging: { param: 'after', next_field: 'next' } },
};
const HOUR = 3600 * 1000;

function host(extra = {}) {
  const asked = [];
  return { asked, data: async () => ({ search_sources: [source] }), now: () => 1000, ...extra,
    request: async url => {
      const query = new URL(url); asked.push(query);
      const name = query.searchParams.get('q') ?? 'everyone';
      return Response.json({ items: [{ id: name, name, about: 'A connector' }], total: 25, next: query.searchParams.has('after') ? null : 'next-page' });
    } };
}

test('with nothing earlier the first page is asked and handed back to keep for an hour; the tool writes nothing', async () => {
  const env = host();
  const first = await connectorsFor(env);
  assert.equal(first.found.connectors[0].name, 'everyone');
  assert.equal(first.found.total, 25);
  assert.deepEqual(first.to_keep.everyone, { found: first.found, expires_at: 1000 + HOUR });
  assert.equal(env.asked.length, 1);
});

test('an earlier first page still fresh answers without asking a catalog, and nothing is handed back to keep', async () => {
  const seed = host();
  const kept = (await connectorsFor(seed)).to_keep.everyone;
  const env = host({ earlier: { everyone: kept }, now: () => 1000 + HOUR - 1 });
  const again = await connectorsFor(env);
  assert.equal(again.found.connectors[0].name, 'everyone');
  assert.equal(env.asked.length, 0, 'a fresh earlier find is the screen answered at once');
  assert.equal(again.to_keep.everyone, null);
});

test('an expired earlier find is asked again and the new find is handed back', async () => {
  const seed = host();
  const kept = (await connectorsFor(seed)).to_keep.everyone;
  const env = host({ earlier: { everyone: kept }, now: () => 1000 + HOUR });
  const again = await connectorsFor(env);
  assert.equal(env.asked.length, 1);
  assert.equal(again.to_keep.everyone.expires_at, 1000 + 2 * HOUR);
});

test("a person's own last search is answered first while fresh, is returned to keep, and never becomes the shared first page", async () => {
  const env = host();
  const search = await findConnectors(env, 'cannot-select-another-account', { text: 'private search' });
  assert.equal(search.found.connectors[0].name, 'private search');
  assert.equal(search.to_keep.own.expires_at, 1000 + HOUR);
  assert.equal(search.to_keep.everyone, undefined, 'a search is the person\'s own');
  const next = await findConnectors(env, 'cannot-select-another-account', { text: 'private search', page: search.found.next_page });
  assert.equal(env.asked.at(-1).searchParams.get('after'), 'next-page');
  assert.equal(next.found.next_page, null);
  const shown = host({ earlier: { own: search.to_keep.own, everyone: null } });
  const answer = await connectorsFor(shown);
  assert.equal(answer.found.connectors[0].name, 'private search');
  assert.equal(shown.asked.length, 0);
  assert.equal(answer.to_keep.everyone, null);
  const expired = host({ earlier: { own: search.to_keep.own }, now: () => 1000 + HOUR });
  assert.equal((await connectorsFor(expired)).found.connectors[0].name, 'everyone', 'an expired own search is not shown');
});

test('unreached catalogs are explicit and nothing is handed back to keep as success', async () => {
  const env = { data: async () => ({ search_sources: [source] }), request: async () => { throw Error('catalog unavailable'); }, now: () => 1000 };
  const answer = await connectorsFor(env);
  assert.equal(answer.found.sources[0].reached, false);
  assert.equal(answer.found.total, null);
  assert.equal(answer.to_keep.everyone, null);
});
