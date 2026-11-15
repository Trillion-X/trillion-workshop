import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSharedLibrary, makeMarketplaceSharedLibrary, handleSharedLibraryRequest } from '../read-data/design-library.mjs';

const records = {
  datasets: [{ id: 'sample', label: 'Sample', description: 'Test rows', found_by: 'words',
    title_field: 'title', meaning_from: ['title'], one_entry_per: ['title'], required: ['title'],
    fields: { title: { type: 'string', title: 'Title', required: true } } }],
  limits: { max_bulk_entries: 4, max_query_characters: 100, default_limit: 10, max_limit: 20 },
  search: { min_similarity: 0.5, words_bonus: 0.1 }, added_by: { yours: 'You', others: 'Member {code}' },
};
const library = pool => makeSharedLibrary({ pool, maker: 'maker:sample', records,
  bytes: () => { throw new Error('This operation must not write a picture.'); }, fileAddress: ref => `/files/${ref}` });

test('bulk validation keeps original positions and submits valid entries once with the admitted maker', async () => {
  const calls = [];
  const owner = library({ async addLibraryEntries(rows) {
    calls.push(rows); return rows.map(row => ({ id: row.id, status: 'added' }));
  } });
  const answer = await owner.add({ dataset: 'sample', entries: [
    { id: 'first', title: 'One' }, 'invalid', { id: 'second', title: 'Two' },
  ] });
  assert.deepEqual(answer.entries.map(row => [row.index, row.status]), [[0, 'added'], [1, 'invalid'], [2, 'added']]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].every(row => row.maker === 'maker:sample' && row.by_words));
});

test('search applies the maker boundary before paging and never presents an unavailable pool as empty', async () => {
  const calls = [];
  const owner = library({ async libraryEntries(input) { calls.push(input); return { rows: [], total: 0 }; } });
  await owner.search({ dataset: 'sample', query: 'card', who: 'mine', offset: 5, limit: 2 });
  assert.equal(calls[0].maker, 'maker:sample');
  assert.equal(calls[0].offset, 5);
  assert.equal(calls[0].limit, 2);
  assert.equal(calls[0].by_words, true);
  await assert.rejects(owner.search({ who: 'maker:other' }), /everyone or mine/);
  await assert.rejects(library({ async libraryEntries() { throw new Error('Pool unavailable'); } }).search({ dataset: 'sample' }), /Pool unavailable/);
});

test('replacement identities and removal stay bound to the admitted contributor', async () => {
  const kept = [], removed = [];
  const pool = {
    async addLibraryEntry(row) { kept.push(row); return { replaced: kept.length > 1, added_at: 'observed' }; },
    async removeLibraryEntry(row) { removed.push(row); return { removed: row.maker === 'maker:sample' }; },
  };
  const owner = library(pool);
  const input = { dataset: 'sample', fields: { title: 'Same source' }, maker: 'maker:other' };
  const first = await owner.add(input), second = await owner.add(input);
  assert.equal(first.id, second.id);
  assert.equal(second.replaced, true);
  assert.ok(kept.every(row => row.maker === 'maker:sample'));
  const other = makeSharedLibrary({ pool, maker: 'maker:other', records, fileAddress: ref => `/files/${ref}` });
  const third = await other.add(input);
  assert.notEqual(first.id, third.id);
  await owner.remove({ id: first.id, maker: 'maker:other' });
  assert.deepEqual(removed[0], { id: first.id, maker: 'maker:sample' });
  await assert.rejects(other.remove({ id: first.id }), /Only the account/);
});

test('pictures require contributor permission and valid signatures before bytes are kept', async () => {
  const content = structuredClone(records), stored = [];
  content.datasets[0].fields.captured = { type: 'boolean' };
  content.datasets[0].image = { kept_only_when: 'captured' };
  content.image = { max_bytes: 64, types: [{ content_type: 'image/png', signature: [{ offset: 0, hex: '89504e470d0a1a0a' }] }] };
  const owner = makeSharedLibrary({ maker: 'maker:sample', records: content,
    pool: { addLibraryEntry: async row => ({ replaced: false, added_at: 'observed' }) },
    bytes: () => ({ put: async (...args) => stored.push(args) }), fileAddress: ref => `/files/${ref}` });
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  await assert.rejects(owner.add({ dataset: 'sample', fields: { title: 'Screen', captured: false }, image }), /captured it yourself/);
  await assert.rejects(owner.add({ dataset: 'sample', fields: { title: 'Screen', captured: true }, image: 'bm90IGEgcGljdHVyZQ==' }), /must be PNG/);
  assert.equal(stored.length, 0);
  const answer = await owner.add({ dataset: 'sample', fields: { title: 'Screen', captured: true }, image });
  assert.equal(stored.length, 1);
  assert.match(stored[0][0], /^1f:[0-9a-f]{64}$/);
  assert.equal(answer.image_url, `/files/${stored[0][0]}`);
});

test('published rows and current rights are rechecked before every operation', async () => {
  const events = [], content = structuredClone(records);
  let unavailable = false, refused = false;
  const owner = makeMarketplaceSharedLibrary({ maker: 'maker:sample', fileAddress: ref => `/files/${ref}`,
    readRecords: async () => { events.push('rows'); if (unavailable) throw new Error('Rows unavailable'); return content; },
    current: async () => { events.push('current'); if (refused) throw new Error('Rights withdrawn'); },
    pool: { libraryEntries: async () => { events.push('pool'); return { rows: [], total: 0 }; } } });
  await owner.search({ dataset: 'sample' });
  assert.deepEqual(events, ['rows', 'current', 'pool']);
  events.length = 0; refused = true;
  await assert.rejects(owner.search({ dataset: 'sample' }), /Rights withdrawn/);
  assert.deepEqual(events, ['rows', 'current']);
  events.length = 0; unavailable = true;
  await assert.rejects(owner.search({ dataset: 'sample' }), /Rows unavailable/);
  assert.deepEqual(events, ['rows']);
});

test('HTTP readers preserve filters and distinguish refusal from unavailable data', async () => {
  let seen;
  const response = await handleSharedLibraryRequest({ search: async input => { seen = input; return { rows: [], total: 0 }; } },
    new Request('https://example.invalid/shared-library?who=mine&offset=2&title=Card&q=screen'));
  assert.equal(response.status, 200);
  assert.deepEqual(seen.filters, { title: 'Card' });
  assert.equal(seen.who, 'mine'); assert.equal(seen.offset, '2'); assert.equal(seen.query, 'screen');
  const refused = await handleSharedLibraryRequest(library({}), new Request('https://example.invalid/shared-library?dataset=missing'));
  assert.equal(refused.status, 404);
  const unavailable = await handleSharedLibraryRequest(library({ libraryEntries: async () => { throw new Error('Pool unavailable'); } }),
    new Request('https://example.invalid/shared-library?dataset=sample'));
  assert.equal(unavailable.status, 502);
  assert.deepEqual(await unavailable.json(), { error: 'Pool unavailable' });
});
