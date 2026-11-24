import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { copyRows } from '../do-work/copy-rows.mjs';

const schema = 'CREATE TABLE items (id text PRIMARY KEY, revision int, words text CHECK (words <> \'refused\'));';
const add = (db, id, revision, words) => db.query('INSERT INTO items VALUES ($1, $2, $3)', [id, revision, words]);
const row = async (db, id) => (await db.query('SELECT revision, words FROM items WHERE id = $1', [id])).rows[0];
const results = answer => answer.keys.map(({ key, result }) => [key, result]);

async function fixture(t) {
  const source = new PGlite();
  const destination = new PGlite();
  t.after(async () => { await Promise.all([source.close(), destination.close()]); });
  await Promise.all([source.exec(schema), destination.exec(schema)]);
  const copy = (keys, options = {}, beforeInsert = async () => {}) => copyRows({
    source: 'synthetic-source', destination: 'synthetic-destination',
    input: { table: 'items', key_column: 'id', keys, ...options },
    connect: async connection => {
      assert.ok(['synthetic-source', 'synthetic-destination'].includes(connection));
      const db = connection === 'synthetic-source' ? source : destination;
      return {
        async query(sql, params) {
          if (db === destination && sql.startsWith('INSERT INTO')) await beforeInsert(db);
          const result = await db.query(sql, params);
          return { rows: result.rows, rowCount: result.affectedRows };
        },
        async end() {},
      };
    },
  });
  return { source, destination, copy };
}

const update = { on_conflict: 'update_when_newer', version_column: 'revision' };

test('a competing insert under do_nothing is kept, never copied', async t => {
  const { source, destination, copy } = await fixture(t);
  await add(source, 'contended', 2, 'toolkit row');
  const answer = await copy(['contended'], {}, db => add(db, 'contended', 3, 'account row'));
  assert.deepEqual(results(answer), [['contended', 'kept']]);
  assert.equal(answer.copied, 0);
  assert.equal(answer.kept, 1);
  assert.notEqual(answer.keys[0].destination_version, answer.keys[0].source_version);
  assert.deepEqual(await row(destination, 'contended'), { revision: 3, words: 'account row' });
});

test('a revised source under do_nothing preserves the local edit and copies the added key', async t => {
  const { source, destination, copy } = await fixture(t);
  await add(source, 'existing', 5, 'revision five');
  await add(source, 'new', 5, 'new toolkit row');
  await add(destination, 'existing', 1, 'local edit');
  const answer = await copy(['existing', 'new']);
  assert.deepEqual(results(answer), [['existing', 'kept'], ['new', 'copied']]);
  assert.equal(answer.copied, 1);
  assert.equal(answer.updated, 0);
  assert.equal(answer.keys[1].source_version, answer.keys[1].destination_version);
  assert.deepEqual(await row(destination, 'existing'), { revision: 1, words: 'local edit' });
  assert.deepEqual(await row(destination, 'new'), { revision: 5, words: 'new toolkit row' });
});

test('a write that loses to a higher competing revision is kept even when the earlier read was empty', async t => {
  const { source, destination, copy } = await fixture(t);
  await add(source, 'contended', 2, 'toolkit row');
  const answer = await copy(['contended'], update, db => add(db, 'contended', 3, 'account row'));
  assert.deepEqual(results(answer), [['contended', 'kept']]);
  assert.equal(answer.copied, 0);
  assert.equal(answer.updated, 0);
  assert.deepEqual(await row(destination, 'contended'), { revision: 3, words: 'account row' });
});

test('versioned copies retain the existing insert and update policy', async t => {
  const { source, destination, copy } = await fixture(t);
  for (const id of ['newer', 'equal', 'older', 'new', 'unknown']) {
    await add(source, id, 2, 'toolkit revision');
  }
  for (const [id, revision] of [['newer', 1], ['equal', 2], ['older', 3], ['unknown', null]]) {
    await add(destination, id, revision, 'account version');
  }
  const answer = await copy(['newer', 'equal', 'older', 'new', 'unknown'], update);
  assert.deepEqual(results(answer), [['newer', 'updated'], ['equal', 'kept'], ['older', 'kept'], ['new', 'copied'], ['unknown', 'kept']]);
  assert.equal((await row(destination, 'newer')).words, 'toolkit revision');
  assert.equal((await row(destination, 'equal')).words, 'account version');
  assert.equal((await row(destination, 'older')).words, 'account version');
  assert.equal((await row(destination, 'unknown')).words, 'account version');
});

test('duplicate requested keys and absent source rows do not produce a copy receipt', async t => {
  const { source, destination, copy } = await fixture(t);
  await add(source, 'added', 1, 'one row');
  const answer = await copy(['added', 'added', 'missing']);
  assert.deepEqual(results(answer), [['added', 'copied'], ['missing', 'missing']]);
  assert.equal(answer.copied, 1);
  assert.equal(answer.missing, 1);
  assert.equal(await row(destination, 'missing'), undefined);
});

test('a later refused insert rolls back the first copy in the batch', async t => {
  const { source, destination, copy } = await fixture(t);
  await source.exec('ALTER TABLE items DROP CONSTRAINT items_words_check');
  await add(source, 'first', 1, 'accepted');
  await add(source, 'second', 1, 'refused');
  await assert.rejects(copy(['first', 'second']), /check constraint/);
  assert.equal(await row(destination, 'first'), undefined);
  assert.equal(await row(destination, 'second'), undefined);
});
