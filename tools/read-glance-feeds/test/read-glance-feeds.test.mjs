import test from 'node:test';
import assert from 'node:assert/strict';
import { readGlanceFeeds } from '../read-data/glance-feeds.mjs';
import { rowOf, runRow } from '../../records-door/test/run-row.mjs';
import toolRows from '../tool-rows.json' with { type: 'json' };
import recipeTools from '../../workflows/tool-rows.json' with { type: 'json' };

function fixture(data) {
  const calls = [];
  const rows = new Map(Object.entries(data.rows ?? {}));
  const door = {
    async *list(query) {
      calls.push(query);
      if (data.error) throw data.error;
      assert.equal(query.type, data.type ?? 'notice-record');
      if (data.prefix) assert.equal(query.prefix, data.prefix);
      for (const row of rows.values()) yield row;
    },
  };
  return { door, calls };
}

const definition = (overrides = {}) => ({
  surfaces: { watch: ['newest', 'other'] },
  feeds: [
    { id: 'newest', label: 'Newest', about: 'Newest rows', empty: 'Nothing new',
      read: { type: 'notice-record', prefix: 'notice:', rows: ['value', 'item'] },
      where: [{ field: ['state'], equals: 'running' }, { field: ['suppressed'], none_of: [true] }, { field: ['title'], present: true }],
      row_id: { prefix: 'told:', field: ['seq'] },
      order: { field: ['seq'], direction: 'desc' },
      show: { title: ['title'], detail: ['body'], note: ['kind'], read: ['read'], actions: ['actions'], open: { path: ['open'] }, time: ['at'] } },
    { id: 'other', label: 'Other', read: { type: 'notice-record', prefix: 'notice:', rows: ['value', 'item'] }, show: { title: ['title'] }, empty: 'No other rows' },
  ], ...overrides,
});

test('one feed reads only its declared record query and projects a source row without losing action data', async () => {
  const { door, calls } = fixture({ prefix: 'notice:', rows: {
    a: { id: 'notice:1', type: 'notice-record', value: { item: { seq: 1, state: 'running', title: 'Older', body: 'Work', kind: 'job', read: false, open: '/jobs/1', actions: [{ id: 'open' }] } } },
    b: { id: 'notice:2', type: 'notice-record', value: { item: { seq: 2, state: 'running', title: 'Newest', body: 'Done', kind: 'task', read: true, open: 'https://example.test/x', at: '2026-10-31T10:00:00Z', actions: [{ id: 'review' }] } } },
    c: { id: 'notice:3', type: 'notice-record', value: { item: { seq: 3, state: 'done', title: 'Filtered', body: 'No', kind: 'task' } } },
    d: { id: 'notice:4', type: 'notice-record', value: { item: { seq: 4, state: 'running', title: '', body: 'No title', kind: 'task' } } },
  } });
  const answer = await readGlanceFeeds({ feed: 'newest' }, { door, data: definition() });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { type: 'notice-record', prefix: 'notice:' });
  assert.deepEqual(answer, { feeds: [{ id: 'newest', label: 'Newest', about: 'Newest rows', empty: 'Nothing new', status: 'ready', rows: [
    { id: 'told:2', title: 'Newest', detail: 'Done', note: 'task', flagged: false, read: true, actions: [{ id: 'review' }], open: 'https://example.test/x', time: '2026-10-31T10:00:00Z', source: { seq: 2, state: 'running', title: 'Newest', body: 'Done', kind: 'task', read: true, open: 'https://example.test/x', at: '2026-10-31T10:00:00Z', actions: [{ id: 'review' }] } },
    { id: 'told:1', title: 'Older', detail: 'Work', note: 'job', flagged: false, read: false, actions: [{ id: 'open' }], open: '/jobs/1', source: { seq: 1, state: 'running', title: 'Older', body: 'Work', kind: 'job', read: false, open: '/jobs/1', actions: [{ id: 'open' }] } },
  ] }] });
});

test('a surface reads feeds concurrently and keeps DATA order in the answer', async () => {
  const started = [];
  const door = { async *list(query) {
    started.push(query.prefix);
    await new Promise(resolve => setTimeout(resolve, query.prefix === 'notice:' ? 15 : 1));
    yield { id: `${query.prefix}one`, type: query.type, value: { item: { title: query.prefix } } };
  } };
  const data = definition();
  const answer = await readGlanceFeeds({ surface: 'watch', limit: 1 }, { door, data });
  assert.deepEqual(started, ['notice:', 'notice:']);
  assert.deepEqual(answer.feeds.map(feed => feed.id), ['newest', 'other']);
  assert.deepEqual(answer.feeds.map(feed => feed.rows.length), [0, 1]);
  assert.equal(answer.feeds[0].empty, 'Nothing new');
});

test('a failed records read remains an error and never becomes a successful empty feed', async () => {
  const error = Object.assign(new Error('records rights refused'), { code: 'current_workspace_rights_refused' });
  const { door } = fixture({ error });
  const answer = await readGlanceFeeds({ feed: 'newest' }, { door, data: definition() });
  assert.equal(answer.feeds[0].status, 'unavailable');
  assert.deepEqual(answer.feeds[0].error, { code: error.code, message: error.message });
  assert.equal(Object.hasOwn(answer.feeds[0], 'rows'), false);
});

test('invalid selection, missing DATA and invalid limits are refused before reading', async () => {
  const { door, calls } = fixture({});
  for (const input of [{}, { feed: 'newest', surface: 'watch' }, { feed: 'missing' }, { surface: 'missing' }, { feed: 'newest', limit: 0 }]) {
    await assert.rejects(readGlanceFeeds(input, { door, data: definition() }));
  }
  await assert.rejects(readGlanceFeeds({ surface: 'broken' }, { door, data: definition({ surfaces: { broken: ['missing'] } }) }), /names missing feed/);
  assert.equal(calls.length, 0);
});

test('a source whose record lacks its declared row path is not treated as empty', async () => {
  const door = { async *list() { yield { id: 'notice:bad', value: {} }; } };
  const answer = await readGlanceFeeds({ feed: 'newest' }, { door, data: definition() });
  assert.equal(answer.feeds[0].status, 'unavailable');
  assert.equal(answer.feeds[0].error.code, 'source_shape');
});

test('the current told feed reads only notice records and returns a valid empty feed when the authorized query is empty', async () => {
  const queries = [];
  const door = { async *list(query) { queries.push(query); } };
  const answer = await readGlanceFeeds({ surface: 'watch' }, { door });
  assert.equal(queries.length, 4);
  assert.ok(queries.some(query => query.type === 'told-the-person' && query.prefix === 'told-the-person:'));
  assert.ok(queries.some(query => query.type === 'record:habit' && query.prefix === 'record:habit:'));
  assert.ok(queries.some(query => query.type === 'record:pursuit' && query.prefix === 'record:pursuit:'));
  assert.deepEqual(answer.feeds.map(({ id, status }) => [id, status]), [
    ['habits', 'ready'], ['pursuits', 'ready'], ['told', 'ready'], ['ai-work', 'ready'],
    ['running', 'unavailable'], ['decisions', 'unavailable'],
  ]);
  assert.equal(answer.feeds.find(feed => feed.id === 'told').empty, 'Nothing new.');
  assert.equal(answer.feeds.find(feed => feed.id === 'running').error.code, 'source_unavailable');
});

test('the registered action reads through its narrow records-door right and refuses another record kind', async () => {
  const row = rowOf(toolRows, 'tool:read-glance-feeds');
  const records = [
    { id: 'told-the-person:1', type: 'told-the-person', value: { item: { seq: 1, title: 'A notice', read: false, open: '/jobs/1' } } },
    { id: 'told-the-person:2', type: 'told-the-person', value: { item: { seq: 2, title: 'Second notice', read: true, open: '/jobs/2' } } },
    { id: 'other:1', type: 'other', value: { item: { seq: 2, title: 'Private row' } } },
  ];
  const allowed = await runRow(row, { feed: 'told' }, { records, doorOptions: { pageCut: 1 } });
  assert.equal(allowed.status, 0);
  assert.deepEqual(allowed.result.feeds[0].rows.map(item => [item.id, item.title, item.open, item.source.read]), [
    ['told:2', 'Second notice', '/jobs/2', true], ['told:1', 'A notice', '/jobs/1', false],
  ]);
  assert.deepEqual(row.invoke.records.rights.map(right => right.kind), [
    'record:habit', 'record:waiting-on-you', 'record:pursuit', 'told-the-person', 'ai-job',
  ]);
  assert.ok(!allowed.result.feeds[0].rows.some(item => item.title === 'Private row'));
});

test('the actual product record models project their current fields and actions without feed-specific branches', async () => {
  const row = rowOf(toolRows, 'tool:read-glance-feeds');
  const records = [
    { id: 'record:habit:move', type: 'record:habit', value: { habit: 'Walk', cue: 'After lunch', easier_path: 'Take the short loop', entry_path: '/habits/move', state: 'Ready' } },
    { id: 'record:habit:ended', type: 'record:habit', value: { habit: 'Old', state: 'Stopped', entry_path: '/habits/old' } },
    { id: 'record:waiting-on-you:approve', type: 'record:waiting-on-you', value: { what: 'Approve draft', why: 'Publishing waits for you', where: '/drafts/7', do_it_in: 'Open the draft', status: 'Waiting', needs: 'your choice' } },
    { id: 'record:pursuit:learn', type: 'record:pursuit', value: { id: 'learn', title: 'Learn geometry', status: 'active' } },
    { id: 'record:pursuit:past', type: 'record:pursuit', value: { id: 'past', title: 'Finished', status: 'done', archived_at: '2026-10-31T00:00:00Z' } },
    { id: 'ai-job:recipe:1', type: 'ai-job', value: { label: 'Prepare lesson', status: 'waiting', cause: 'Monday plan', job: 'teach' } },
    { id: 'ai-job:recipe:2', type: 'ai-job', value: { label: 'Old job', status: 'done', cause: 'yesterday' } },
  ];
  for (const feed of ['habits', 'waiting', 'pursuits', 'ai-work']) {
    const answer = await runRow(row, { feed }, { records, doorOptions: { pageCut: 1 } });
    assert.equal(answer.status, 0, feed);
    assert.equal(answer.result.feeds[0].status, 'ready', feed);
    const recordsRead = answer.calls.filter(call => call.method === 'records:list');
    assert.ok(recordsRead.length > 0, `${feed} used the records door`);
    assert.ok(recordsRead.every(call => call.input.type === recordsRead[0].input.type), `${feed} queried one declared type`);
    assert.equal(answer.result.feeds[0].rows.length, 1, `${feed} filtered the source records`);
  }
  const pursuit = await runRow(row, { feed: 'pursuits' }, { records });
  assert.deepEqual(pursuit.result.feeds[0].rows.map(item => [item.title, item.open]), [['Learn geometry', '/pursuits/learn']]);
});

// Cross the actual producer/consumer boundary: a recipe wake writes ai-job, never record:ai-job.
test('the AI work feed reads the actual recipe starter output and hides it after completion', async () => {
  const starter = rowOf(recipeTools, 'tool:start-a-recipe-run');
  const started = await runRow(starter, {
    input: { row: 'workflow:read-the-week-and-make-more-of-what-won' },
    task: { request_key: 'glance-producer-consumer-proof' },
  });
  assert.equal(started.status, 0, started.error);
  const feed = rowOf(toolRows, 'tool:read-glance-feeds');
  const answer = await runRow(feed, { feed: 'ai-work' }, { records: started.kept });
  assert.equal(answer.status, 0, answer.error);
  assert.equal(answer.result.feeds[0].status, 'ready');
  assert.deepEqual(answer.result.feeds[0].rows.map(row => row.id), [started.result.job]);
  assert.ok(answer.result.feeds[0].rows[0].title.length);
  const finished = started.kept.map(record => ({ ...record, value: { ...record.value, status: 'done' } }));
  const done = await runRow(feed, { feed: 'ai-work' }, { records: finished });
  assert.deepEqual(done.result.feeds[0].rows, []);
});
