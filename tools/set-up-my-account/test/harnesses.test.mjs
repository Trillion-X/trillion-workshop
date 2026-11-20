// Ported from the retired repository test/harnesses.test.mjs (b6ae0ebf81): the tests of read-data/harnesses.mjs and harnesses.json that need
// only them, assertions unchanged. The tests that drove the old message store and the inbound door (a Codex guard
// reading mustUseTranscriptForPerson, a recorded message's app canonicalized, receiveKept's chat wait) belong to
// tools/keep-and-wake-ai-sessions-on-this-computer and tools/bring-in-what-i-write-elsewhere, which own those modules now;
// the recheck-script test ran harness/recheck-source-return.mjs in the old repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aiProducts, canonicalApp, harnessFor, harnessOf, isFinalReply, sourceChat, transcriptHookApps } from '../read-data/harnesses.mjs';
import rows from '../read-data/harnesses.json' with { type: 'json' };

const NOW = new Date('2026-10-07T12:00:00Z');
const ago = minutes => new Date(NOW - minutes * 60_000).toISOString();
const person = { speaker: 'person', text: 'Please fix the sidebar' };
const reply = { speaker: 'ai', text: 'Done.' };

test('every row has the same fields and ids and names never collide', () => {
  const names = rows.harnesses.flatMap(row => [...new Set([row.app, ...row.names].map(name => name.toLowerCase()))]);
  assert.equal(new Set(names).size, names.length, 'no name belongs to two rows');
  for (const row of [...rows.harnesses, rows.default]) {
    assert.deepEqual(Object.keys(row).filter(key => !key.startsWith('consults_') && !['source_return', 'product', 'contains', 'standing_instructions'].includes(key)).sort(), ['app', 'id', 'names', 'replies', 'takes_work', 'turns']);
    assert.ok(row === rows.default ? row.product === undefined : typeof row.product === 'string' && row.product.trim(), 'a harness row names its product');
    assert.ok(row.source_return === undefined || row.source_return === 'transcript');
    assert.ok(['marked', 'recorded-live'].includes(row.replies.final_when));
    assert.ok(row.contains === undefined || row.contains.every(word => typeof word === 'string' && word.trim().length >= 3), 'contains words are real words');
  }
});

test('a recorded-live AI reply is final only while it is recent; a marked app needs its own mark', () => {
  assert.equal(isFinalReply({ ...reply, app: 'Muse', at: ago(2) }, NOW), true);
  assert.equal(isFinalReply({ ...reply, app: 'Muse', at: ago(120) }, NOW), false);
  assert.equal(isFinalReply({ ...reply, app: 'Codex', at: ago(2) }, NOW), false);
  assert.equal(isFinalReply({ ...reply, app: 'Codex', at: ago(2), final_reply: true }, NOW), true);
  assert.equal(isFinalReply({ ...person, app: 'Muse', at: ago(2) }, NOW), false, 'only an AI reply ends a turn');
});

test('an unknown app uses the default row and is kept as typed', () => {
  assert.equal(harnessOf('Brand New Chat'), null);
  assert.equal(harnessFor('Brand New Chat'), rows.default);
  assert.equal(canonicalApp('  Brand New Chat '), 'Brand New Chat');
  assert.equal(isFinalReply({ ...reply, app: 'Brand New Chat', at: ago(2) }, NOW), true);
});

test('the text telling an AI where its turns are recorded names the apps from the rows', () => {
  assert.deepEqual(transcriptHookApps().sort(), ['Claude Code', 'Codex']);
});

test('a source chat id names its row and session, and only transcript-returning apps have one', () => {
  const session = '01a0cee9-02df-76e2-a6ea-6f202cbd0668';
  assert.equal(sourceChat(`codex:${session}`).row.app, 'Codex');
  assert.equal(sourceChat(`claude-code:${session}`).session, session);
  for (const id of [`muse:${session}`, `codex:${session}x`, 'codex:nope', `unknown:${session}`, undefined]) assert.equal(sourceChat(id), null);
});

test('the connected AIs of a live account are named by product, from the joined names a key is seen as', () => {
  // Shaped exactly as GET /work/api/ai-connection answered for the owner (apps joined with " and " per sign-in).
  const apps = [
    'Claude Code diagnostic and claude-code',
    'claude-code and Claude Code and t and call-long and latency-probe',
    'decide-before-building and Claude Code and account-note-guard and claude-code and Drive keeper and bash-bridge and c and codex-native-sites and header-proof and Terminal',
  ];
  assert.deepEqual(aiProducts(apps), ['Claude', 'Codex']);
  assert.deepEqual(aiProducts(['call-long and latency-probe and Terminal']), []);
  assert.deepEqual(aiProducts([{ app: 'Codex', name: 'codex-native-sites' }, { harness: 'Claude Code' }]), ['Codex', 'Claude']);
});
