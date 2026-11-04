import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { decisionStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/decision-store.mjs';
import { notices } from '../src/notices.mjs';

const owner = () => {
  const host = sqliteHost(':memory:');
  return { host, board: notices(decisionStore(host.sql, { transaction: host.transaction }).eeaf) };
};
const add = (board, key, extra = {}) => board.add({ kind: 'work', key, said: key, ...extra });

test('established notice readers drain every ordinary notice in bounded oldest-first pages', () => {
  const { host, board } = owner();
  try {
    add(board, 'baseline');
    board.unseen('reader');
    for (let i = 0; i < 23; i++) add(board, `work-${i}`);
    const first = board.peek('reader');
    assert.deepEqual(first.notices.map(row => row.said), Array.from({ length: 10 }, (_, i) => `work-${i}`));
    assert.deepEqual(board.peek('reader'), first, 'a failed reply spends nothing');
    assert.equal(board.see(first.claim), true);
    assert.equal(board.see(first.claim), false, 'concurrent stale claims are refused');
    const rest = [...board.unseen('reader'), ...board.unseen('reader')];
    assert.deepEqual(rest.map(row => row.said), Array.from({ length: 13 }, (_, i) => `work-${i + 10}`));
    assert.deepEqual(board.unseen('reader'), []);
  } finally { host.db.close(); }
});

test('addressed notices jump ahead once without spending the ordinary backlog or repeating on unchanged frontier', () => {
  const { host, board } = owner();
  try {
    add(board, 'baseline'); board.unseen('reader');
    for (let i = 0; i < 12; i++) add(board, `ordinary-${i}`);
    for (let i = 0; i < 11; i++) add(board, `direct-${i}`, { for_reader: 'reader' });
    const first = board.peek('reader');
    assert.deepEqual(first.notices.map(row => row.said), Array.from({ length: 11 }, (_, i) => `direct-${i}`));
    assert.equal(board.see(first.claim), true);
    assert.equal(board.see(first.claim), false, 'same frontier with changed delivered set still fences concurrent claim');
    const rest = [...board.unseen('reader'), ...board.unseen('reader')];
    assert.deepEqual(rest.map(row => row.said), Array.from({ length: 12 }, (_, i) => `ordinary-${i}`));
    assert.deepEqual(board.unseen('reader'), []);
  } finally { host.db.close(); }
});

test('new readers still begin with the recent newest ordinary batch and all addressed notices', () => {
  const { host, board } = owner();
  try {
    for (let i = 0; i < 15; i++) add(board, `work-${i}`);
    add(board, 'direct', { for_reader: 'reader' });
    assert.deepEqual(board.unseen('reader').map(row => row.said), [...Array.from({ length: 9 }, (_, i) => `work-${i + 6}`), 'direct']);
    assert.deepEqual(board.unseen('reader'), []);
  } finally { host.db.close(); }
});
