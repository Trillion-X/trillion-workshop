import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { searchWordIndex } from '../src/search-word-index.mjs';

const rows = (sql, query, ...args) => sql.exec(query, ...args).toArray();

test('one changed document replaces its FTS row through indexed rowid lookups', () => {
  const { sql } = sqliteHost(':memory:');
  const queries = [];
  const measured = { exec(query, ...args) { queries.push(query); return sql.exec(query, ...args); } };
  const words = searchWordIndex(measured);
  words.replace('contents-words', 'file-a', 'blue orchid');
  words.replace('contents-words', 'file-a', 'red dune');
  assert.deepEqual(rows(sql, "SELECT identity FROM search_words WHERE search_words MATCH 'dune'").map(row => row.identity), ['file-a']);
  assert.deepEqual(rows(sql, "SELECT identity FROM search_words WHERE search_words MATCH 'orchid'"), []);
  assert.equal(rows(sql, 'SELECT count(*) AS n FROM search_word_rows')[0].n, 1);
  assert.equal(queries.some(query => /^DELETE FROM search_words WHERE lane/.test(query)), false);
  assert.ok(queries.some(query => query === 'DELETE FROM search_words WHERE rowid = ?'));
  const mapPlan = rows(sql, "EXPLAIN QUERY PLAN SELECT word_row FROM search_word_rows WHERE lane = 'contents-words' AND identity = 'file-a'");
  assert.ok(mapPlan.some(row => /SEARCH search_word_rows USING COVERING INDEX search_word_rows_result/.test(row.detail)));
  const ftsPlan = rows(sql, 'EXPLAIN QUERY PLAN DELETE FROM search_words WHERE rowid = 1');
  assert.ok(ftsPlan.some(row => /VIRTUAL TABLE INDEX 0:=/.test(row.detail)));
  words.forget('contents-words', 'file-a');
  assert.equal(rows(sql, 'SELECT count(*) AS n FROM search_words')[0].n, 0);
});

test('existing FTS rows stay searchable while their mapping is admitted in bounded pages', () => {
  const { sql } = sqliteHost(':memory:');
  sql.exec('CREATE VIRTUAL TABLE search_words USING fts5(lane UNINDEXED, identity UNINDEXED, text)');
  for (let n = 1; n <= 5; n += 1) sql.exec('INSERT INTO search_words (lane, identity, text) VALUES (?, ?, ?)', 'contents-words', `file-${n}`, `legacyword ${n}`);
  const queries = [];
  const counted = { exec(query, ...args) { queries.push(query); return sql.exec(query, ...args); } };
  const words = searchWordIndex(counted);
  assert.equal(words.pending(), true);
  queries.length = 0;
  assert.equal(words.admit(2), true);
  assert.equal(queries.some(query => /FROM search_words WHERE rowid\s*[><]/.test(query)), false,
    'admission does not walk the FTS5 virtual table, whose billed reads grow with its cursor');
  assert.ok(queries.some(query => /FROM search_words_content WHERE id > \? ORDER BY id LIMIT \?/.test(query)));
  const pagePlan = rows(sql, 'EXPLAIN QUERY PLAN SELECT id FROM search_words_content WHERE id > ? ORDER BY id LIMIT ?', 0, 2);
  const copyPlan = rows(sql, 'EXPLAIN QUERY PLAN INSERT OR IGNORE INTO search_word_rows (word_row, lane, identity) SELECT id, c0, c1 FROM search_words_content WHERE id > ? AND id <= ?', 0, 2);
  assert.ok([...pagePlan, ...copyPlan].every(row => /SEARCH search_words_content USING INTEGER PRIMARY KEY/.test(row.detail)),
    'both admission reads seek the FTS content table by its integer row id');
  assert.equal(rows(sql, 'SELECT count(*) AS n FROM search_word_rows')[0].n, 2);
  assert.equal(rows(sql, "SELECT count(*) AS n FROM search_words WHERE search_words MATCH 'legacyword'")[0].n, 5);
  const reopened = searchWordIndex(sql);
  assert.equal(reopened.admit(2), true);
  assert.equal(rows(sql, 'SELECT count(*) AS n FROM search_word_rows')[0].n, 4);
  assert.equal(reopened.admit(2), false);
  assert.equal(rows(sql, 'SELECT count(*) AS n FROM search_word_rows')[0].n, 5);
  reopened.replace('contents-words', 'file-3', 'freshword');
  assert.equal(rows(sql, "SELECT count(*) AS n FROM search_words WHERE search_words MATCH 'freshword'")[0].n, 1);
  assert.equal(rows(sql, "SELECT count(*) AS n FROM search_words WHERE search_words MATCH 'legacyword'")[0].n, 4);
});

test('admission maps duplicate old rows so one replacement removes both', () => {
  const { sql } = sqliteHost(':memory:');
  sql.exec('CREATE VIRTUAL TABLE search_words USING fts5(lane UNINDEXED, identity UNINDEXED, text)');
  sql.exec("INSERT INTO search_words (lane, identity, text) VALUES ('contents-words', 'one', 'oldword one'), ('contents-words', 'one', 'oldword two')");
  const words = searchWordIndex(sql);
  assert.equal(words.admit(10), false);
  words.replace('contents-words', 'one', 'newword');
  assert.equal(rows(sql, "SELECT count(*) AS n FROM search_words WHERE search_words MATCH 'oldword'")[0].n, 0);
  assert.equal(rows(sql, "SELECT count(*) AS n FROM search_words WHERE search_words MATCH 'newword'")[0].n, 1);
  assert.equal(rows(sql, 'SELECT count(*) AS n FROM search_word_rows')[0].n, 1);
});
