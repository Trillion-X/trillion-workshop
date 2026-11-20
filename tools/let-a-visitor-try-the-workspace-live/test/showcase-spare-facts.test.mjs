// tools/let-a-visitor-try-the-workspace-live: a live showcase's spare facts keep their names and their one-holder hold rule.
// Over an in-memory SQLite (node:sqlite) standing in for the account's own records.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { showcaseSpareFacts } from '../src/showcase-spare-facts.mjs';

const memorySql = () => {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query, ...params) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) { const rows = statement.all(...params); return { toArray: () => rows }; }
      statement.run(...params);
      return { toArray: () => [] };
    },
  };
};

test('a spare fact keeps only the names its showcase row lists', () => {
  const facts = showcaseSpareFacts(memorySql());
  assert.equal(facts.fact('throwaway_spare'), null);
  assert.throws(() => facts.fact('not_a_spare_fact'), /not a showcase spare fact/);
  assert.throws(() => facts.keep('not_a_spare_fact', 1), /not a showcase spare fact/);
});

test('keep writes, reads back and removes a value', () => {
  const facts = showcaseSpareFacts(memorySql());
  assert.deepEqual(facts.keep('throwaway_spare', { next: 0, done: false }), { next: 0, done: false });
  assert.deepEqual(facts.fact('throwaway_spare'), { next: 0, done: false });
  facts.keep('throwaway_spare', null);
  assert.equal(facts.fact('throwaway_spare'), null);
});

test('one holder at a time: a second holder is refused until the hold ends', () => {
  const facts = showcaseSpareFacts(memorySql());
  assert.equal(facts.hold('throwaway_claimed', 'a', null, 1000), true);
  assert.equal(facts.hold('throwaway_claimed', 'b', null, 1000), false, 'the other caller is refused');
  assert.equal(facts.hold('throwaway_claimed', 'a', null, 1000), true, 'the holder holds it again');
  assert.equal(facts.hold('throwaway_spare_writer', 'w1', 500, 1000), true);
  assert.equal(facts.hold('throwaway_spare_writer', 'w2', 500, 1200), false, 'still held until 1500');
  assert.equal(facts.hold('throwaway_spare_writer', 'w2', 500, 1600), true, 'the hold ended after its ms');
});

test('a hold names its holder', () => {
  const facts = showcaseSpareFacts(memorySql());
  assert.throws(() => facts.hold('throwaway_claimed', '', null, 1), /names its holder/);
  assert.throws(() => facts.hold('throwaway_claimed', 'a', Number.NaN, 1), /how long it lasts/);
});
