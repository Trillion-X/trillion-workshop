// The funnel-by-source read: one fixed statement, its columns and rows as answered, and no connection opened without a held one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { funnelBySource, FUNNEL_SQL } from '../do-work/show-funnel-by-source.mjs';

test('reads the view once with the fixed statement and answers its columns and rows', async () => {
  const sent = [];
  const client = {
    query: async q => { sent.push(q); return { fields: [{ name: 'source' }, { name: 'visitors' }], rows: [{ source: 'instagram', visitors: '3' }] }; },
    end: async () => {},
  };
  const answer = await funnelBySource({ connection: 'postgres://held', proxy: '', connect: async () => client });
  assert.deepEqual(answer, { columns: ['source', 'visitors'], rows: [{ source: 'instagram', visitors: '3' }], row_count: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, FUNNEL_SQL);
});

test('refuses a run with no held connection before opening one', async () => {
  let opened = false;
  await assert.rejects(
    funnelBySource({ connection: '', proxy: '', connect: async () => { opened = true; } }),
    /not held/,
  );
  assert.equal(opened, false);
});

test('the statement reads the view only, with a row limit and the visitor-first order', () => {
  assert.match(FUNNEL_SQL, /FROM funnel_by_source /);
  assert.match(FUNNEL_SQL, /LIMIT 500$/);
  assert.doesNotMatch(FUNNEL_SQL, /\*/);
});
