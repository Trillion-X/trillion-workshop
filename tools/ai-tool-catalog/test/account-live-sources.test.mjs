// Synthetic source definitions, cache rows and network answers, through the real derivation/protocol reader. The caller's
// store is a Map here: each read is given its rows and the keep rows it answers are written back with their expected
// values, as the caller does in the real run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readAccountLiveSources, readLiveSourcesFromTask, deriveLiveSourcesFromTask } from '../do-work/account-live-sources.mjs';

const from = (where, field) => ({ fill: { from: where, field } });
function config(kind = 'openapi') {
  return { check_every_minutes: 60, retry_ceiling_minutes: 60, kinds: {
    openapi: { source: { kind: 'tool-row-source', id: from('source', 'id'), id_prefix: from('source', 'tool_prefix'),
      list: { openapi: { url: from('source', 'url'), headers: from('source', 'headers'), connection: from('source', 'connection') } },
      entry: { id: 'operation', label: 'label', job: 'job', input_schema: 'input_schema', method: 'method', url: 'url' },
      row: { invoke: { kind: 'http', method: from('entry', 'method'), url: from('entry', 'url') } } } },
  }, sources: [{ id: 'fixture', kind, url: 'https://fixture.example/description' }] };
}
const document = { openapi: '3.0.0', servers: [{ url: 'https://fixture.example/api' }], paths: {
  '/answer': { get: { operationId: 'answer', summary: 'Read answer', responses: { 200: { description: 'Answer' } } } },
} };

function owner(selected = config()) {
  const records = new Map(), writes = [], asks = [];
  let time = Date.parse('2026-11-08T00:00:00Z');
  const state = {
    selected, records, writes, asks,
    now: () => new Date(time), advance: ms => { time += ms; },
    async request(url, init) { asks.push({ url, init }); return new Response(JSON.stringify(document), { headers: { etag: 'fixture-v1' } }); },
    sourceConfig: { config: async () => state.selected },
  };
  return state;
}

// The caller's side: the rows the read is given, then its keep rows written back where each expected value still holds.
const given = state => [...state.records].map(([id, row]) => ({ id, type: row.type, value: row.value }));
function keepIn(state, answer) {
  for (const row of answer.keep ?? []) {
    const old = state.records.get(row.id) ?? null;
    assert.deepEqual(old ? { type: old.type, value: old.value } : null, row.expected, `expected value moved for ${row.id}`);
    state.records.set(row.id, { type: row.type, value: structuredClone(row.value) });
  }
  if (answer.keep?.length) state.writes.push(structuredClone(answer.keep));
  return answer;
}
const read = (state, input = {}, key = 'fixture-run') => Promise.resolve(readLiveSourcesFromTask({
  input: { ...input, stored: { records: given(state) } }, source_data: { config: state.selected }, request_key: key }, state))
  .then(answer => keepIn(state, answer));

test('independent cold reads start together and retain source precedence when replies arrive out of order', { timeout: 1000 }, async () => {
  const selected = config();
  selected.sources.push({ id: 'second', kind: 'openapi', url: 'https://second.example/description' });
  const state = owner(selected), started = [];
  let releaseBoth, releaseSecond;
  const both = new Promise(resolve => { releaseBoth = resolve; });
  const second = new Promise(resolve => { releaseSecond = resolve; });
  state.request = async url => {
    started.push(String(url));
    if (started.length === 2) releaseBoth();
    await both;
    if (String(url).includes('fixture.example')) await second;
    else releaseSecond();
    return new Response(JSON.stringify(document));
  };
  const result = await read(state, { need: true, wait: true });
  assert.equal(started.length, 2);
  assert.deepEqual(result.reads.map(item => item.source_id), ['fixture', 'second']);
  assert.deepEqual(result.rows.map(row => row.id), ['tool:fixture:answer', 'tool:second:answer']);
});

test('public OpenAPI discovery derives current rows and a fresh run uses the conditional cache its caller gives back', async () => {
  const state = owner(), first = await read(state);
  assert.equal(first.reads[0].state, 'ready');
  assert.deepEqual(first.reads[0].tools, ['tool:fixture:answer']);
  assert.equal(first.rows[0].invoke.kind, 'http');
  assert.equal(first.rows[0].invoke.url, 'https://fixture.example/api/answer');
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0][0].expected, null, 'a first read expects no cache row');
  assert.equal([...state.records.values()][0].value.rows, undefined, 'cache keeps entries, not executable descriptors');
  assert.deepEqual((await read(state)).rows, first.rows);
  assert.equal(state.asks.length, 1);
  state.advance(61 * 60000);
  state.request = async (url, init) => { state.asks.push({ url, init }); return new Response(null, { status: 304 }); };
  const next = await read(state, {}, 'fixture-next');
  assert.deepEqual(next.rows, first.rows);
  assert.equal(next.reads[0].read_at, first.reads[0].read_at);
  assert.equal(state.asks[1].init.headers['if-none-match'], 'fixture-v1');
  assert.equal(state.writes[1][0].expected.value.etag, 'fixture-v1', 'the next keep names the row it replaces');
});

test('a failed first source is unavailable, persists backoff, and recovers after its bounded retry', async () => {
  const state = owner();
  state.request = async () => { state.asks.push({}); throw new Error('remote text must never escape'); };
  const failed = await read(state);
  assert.equal(failed.reads[0].state, 'unavailable');
  assert.equal(failed.reads[0].error, 'source_remote_unavailable');
  assert.deepEqual(failed.rows, []);
  await read(state, {}, 'fixture-other-run');
  assert.equal(state.asks.length, 1);
  state.advance(61000);
  state.request = async () => { state.asks.push({}); return new Response(JSON.stringify(document)); };
  assert.equal((await read(state, {}, 'fixture-recovery')).reads[0].state, 'ready');
});

test('removal and changed template invalidate the old cache, including private/default collisions', async () => {
  const state = owner();
  state.records.set('tool-source:fixture', { type: 'tool-source', value: { id: 'fixture', kind: 'openapi', url: 'https://own.example/openapi', added_at: 'original-time' } });
  assert.equal((await read(state)).reads[0].scope, 'account');
  assert.equal(state.asks[0].url, 'https://own.example/openapi');
  state.records.get('tool-source:fixture').value.status = 'deleted';
  const after = await read(state, { wait: false }, 'fixture-after-remove');
  assert.equal(after.reads[0].scope, 'default');
  assert.equal(after.reads[0].state, 'pending');
  assert.deepEqual(after.rows, []);
  state.selected.kinds.openapi.source.row.invoke.method = 'POST';
  assert.deepEqual((await read(state, { wait: false }, 'fixture-after-template')).rows, []);
});

test('a configuration change during fetch refuses the cache and the output', async () => {
  const state = owner();
  state.request = async () => {
    state.selected.kinds.openapi.source.row.invoke.method = 'POST';
    return new Response(JSON.stringify(document));
  };
  await assert.rejects(read(state), { code: 'source_configuration_changed' });
  assert.equal(state.writes.length, 0);
});

test('private-address redirects, credentials and request-supplied source authority never reach fetch', async () => {
  const state = owner();
  state.request = async (url, init) => { state.asks.push({ url, init }); return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }); };
  const result = await read(state);
  assert.equal(result.reads[0].state, 'unavailable');
  assert.equal(state.asks.length, 1);
  state.selected.sources[0].headers = { authorization: 'synthetic-secret-marker' };
  assert.equal((await read(state, {}, 'credentials')).reads[0].error, 'source_credential_metadata_refused');
  assert.equal(state.asks.length, 1);
  await assert.rejects(read(state, { source_data: { config: config() } }), { code: 'source_input_refused' });
  assert.throws(() => readLiveSourcesFromTask({ input: {} }), { code: 'source_owner_unavailable' });
});

test('a read given no source definitions or cache rows is a read with nothing kept, and names what it made as keep only', async () => {
  const state = owner(), first = await read(state, {}, 'one-task');
  assert.equal(first.reads[0].state, 'ready');
  assert.equal(first.keep.length, 1);
  assert.equal(first.keep[0].type, 'tool-source-read');
  assert.match(first.keep[0].id, /^tool-source-read:/);
  assert.deepEqual((await read(state, {}, 'one-task')).rows, first.rows);
  assert.equal(state.asks.length, 1, 'the cache row given back is read without another fetch');
});

test('a cache row that no longer matches the caller\'s copy is refused by its expected value and nothing is kept over it', async () => {
  const state = owner();
  await read(state, {}, 'first');
  const [id] = state.records.keys();
  state.advance(61 * 60000);
  const answer = await readLiveSourcesFromTask({ input: { stored: { records: given(state) } }, source_data: { config: state.selected }, request_key: 'second' }, state);
  assert.equal(answer.keep.length, 1);
  state.records.set(id, { type: 'tool-source-read', value: { moved: true } });
  assert.throws(() => keepIn(state, answer), /expected value moved/);
});

test('cache descriptor fields cannot replace derivation from the current native-selected template', async () => {
  const state = owner(), original = await read(state);
  const cached = [...state.records.values()][0];
  cached.value.rows = [{ id: 'tool:fixture:answer', invoke: { kind: 'container', run: ['unselected-program'] }, trusted: true }];
  cached.value.trusted = true;
  const next = await read(state, {}, 'other-native-task');
  assert.deepEqual(next.rows, original.rows);
  assert.equal(next.rows[0].invoke.kind, 'http');
  assert.equal(next.rows[0].trusted, undefined);
  assert.equal(state.asks.length, 1);
});

test('body limits refuse complete-ready claims and a cold read requires native retry identity', async () => {
  const bounded = owner();
  bounded.selected.max_description_bytes = 32;
  assert.equal((await read(bounded)).reads[0].error, 'source_read_bounds');
  assert.deepEqual((await read(bounded)).rows, []);
  const missing = owner();
  await assert.rejects(readAccountLiveSources({}, { definitionSnapshot: [], sourceConfig: missing.sourceConfig, request: missing.request, now: missing.now }), { code: 'source_request_key_required' });
  assert.equal(missing.asks.length, 0);
});

test('native source derivation opens no caller records and creates no cache row', async () => {
  const state = owner(), nativeOwn = [{ id: 'fixture', kind: 'openapi', url: 'https://native-own.example/openapi', added_at: 'original-time' }];
  const answer = await readAccountLiveSources({ need: 'tool:fixture:answer' }, {
    definitionSnapshot: nativeOwn, sourceConfig: state.sourceConfig,
    request: state.request, requestKey: 'native-resolve-key', now: state.now,
  });
  assert.equal(answer.rows[0].id, 'tool:fixture:answer');
  assert.equal(answer.reads[0].scope, 'account');
  assert.equal(answer.reads[0].cache_state, 'not_kept');
  assert.equal(answer.keep, undefined);
  assert.equal(state.asks[0].url, 'https://native-own.example/openapi');
  assert.equal(answer.reads[0].root_identity, undefined);
  assert.deepEqual((await deriveLiveSourcesFromTask({ input: { need: 'tool:fixture:answer', wait: false },
    source_data: { config: state.selected, own: nativeOwn }, request_key: 'native-resolve-key' })).rows, []);
  assert.throws(() => deriveLiveSourcesFromTask({ input: {}, source_data: { config: state.selected } }), { code: 'source_owner_unavailable' });
  await assert.rejects(deriveLiveSourcesFromTask({ input: { source_data: { config: config() } },
    source_data: { config: state.selected, own: nativeOwn }, request_key: 'native-resolve-key' }), { code: 'source_input_refused' });
});

test('native raw cache snapshots derive current rows without records, network or writes', async () => {
  const state = owner(), original = await read(state);
  const cacheSnapshot = [...state.records].map(([id, row]) => ({ id, value: structuredClone(row.value) }));
  assert.equal(cacheSnapshot[0].value.source_id, 'fixture');
  cacheSnapshot[0].value.rows = [{ id: 'tool:fixture:answer', invoke: { kind: 'container', run: ['unselected-program'] } }];
  const forbidden = () => { throw new Error('native cache read must not open records or network'); };
  const context = { definitionSnapshot: [], cacheSnapshot, sourceConfig: state.sourceConfig,
    request: forbidden, requestKey: 'native-cache-read', now: state.now };
  const answer = await readAccountLiveSources({ need: 'tool:fixture:answer', wait: false }, context);
  assert.deepEqual(answer.rows, original.rows);
  assert.equal(answer.rows[0].invoke.kind, 'http');
  assert.equal(answer.reads[0].state, 'ready');
  assert.equal(answer.keep, undefined);
  assert.deepEqual((await deriveLiveSourcesFromTask({ input: { need: 'tool:fixture:answer', wait: false },
    source_data: { config: state.selected, own: [], cache: cacheSnapshot }, request_key: 'native-cache-wrapper' })).rows, original.rows);
  assert.equal(state.asks.length, 1);

  state.selected.kinds.openapi.source.row.invoke.method = 'POST';
  assert.deepEqual((await readAccountLiveSources({ wait: false }, context)).rows, [], 'changed current template rejects old entries');
  state.selected = config();
  const own = [{ ...state.selected.sources[0], url: 'https://new-own.example/openapi' }];
  assert.deepEqual((await readAccountLiveSources({ wait: false }, { ...context, definitionSnapshot: own })).rows, [],
    'changed private definition rejects old default cache');
});

test('native cache key phase selects exact current identities without remote reads or cache history enumeration', async () => {
  const state = owner();
  await read(state);
  const [expected] = state.records.keys();
  const forbidden = () => { throw new Error('cache key phase must not open a remote'); };
  const context = { definitionSnapshot: [], sourceConfig: state.sourceConfig, cacheKeysOnly: true,
    request: forbidden, now: state.now };
  assert.deepEqual((await readAccountLiveSources({ need: 'tool:fixture:answer' }, context)).cache_ids, [expected]);
  const wrapped = await deriveLiveSourcesFromTask({ input: { need: 'tool:fixture:answer' },
    source_data: { config: state.selected, own: [], cache_keys_only: true } });
  assert.deepEqual(wrapped.cache_ids, [expected]);
  assert.deepEqual(wrapped.rows, []);
  state.selected.sources[0].url = 'https://changed.example/openapi';
  assert.notDeepEqual((await readAccountLiveSources({}, context)).cache_ids, [expected]);
  assert.deepEqual((await readAccountLiveSources({ need: 'tool:other:answer' }, context)).cache_ids, []);
  await assert.rejects(readAccountLiveSources({ cache_keys_only: true }, context), { code: 'source_input_refused' });
});

test('the original web-list branch keeps conditional reads, unchanged content versions and current derivation', async () => {
  const selected = config();
  selected.kinds.list = { source: { kind: 'tool-row-source', id: from('source', 'id'), id_prefix: from('source', 'tool_prefix'),
    list: { url: from('source', 'url'), items_field: 'tools' }, entry: { id: 'name', label: 'title', job: 'description', input_schema: 'inputSchema' },
    row: { invoke: { kind: 'http', method: 'GET', url: 'https://list.example/answer' } } } };
  selected.sources = [{ id: 'list', kind: 'list', url: 'https://list.example/tools' }];
  const state = owner(selected), body = JSON.stringify({ tools: [{ name: 'answer', title: 'Answer', description: 'From original list', inputSchema: { type: 'object' } }] });
  state.request = async (url, init) => { state.asks.push({ url, init }); return new Response(body, { headers: { etag: 'list-v1' } }); };
  const first = await read(state);
  assert.equal(first.rows[0].id, 'tool:list:answer');
  state.advance(61 * 60000);
  const same = await read(state, {}, 'list-next');
  assert.equal(same.reads[0].read_at, first.reads[0].read_at);
  assert.equal(same.reads[0].version, first.reads[0].version);
  assert.equal(state.asks[1].init.headers['if-none-match'], 'list-v1');
  state.advance(61 * 60000);
  state.request = async () => new Response(null, { status: 304 });
  assert.equal((await read(state, {}, 'list-unmodified')).reads[0].read_at, first.reads[0].read_at);
});
