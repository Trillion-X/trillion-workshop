// Ported from old trillion test/ais.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. One list of the person's AIs (src/ais.mjs here, on the record engine of
// keep-and-wake-ai-sessions-on-this-computer). Six tests are the old ones; a sign-in id is made as old
// src/mcp-client-identity.mjs mcpSignInId made it (that file runs nowhere), and the store that counts statements is a
// stand-in for old test/person-store-reads-for-tests.mjs countingHost. Left out, each searched in trillion-workshop tools/,
// trillion-apps web/ and trillion-rust src/ with no running code found: setup's connected-AI names and Trillion's own programs
// (old src/connected-ais.mjs connectedAiNames, clientsOfAis), the source reads of old src/account-routes.mjs,
// src/screen-reads.mjs and src/person-store.mjs (find_agents answered from person.ais()), the key-space scan of old src/,
// the Connect-your-AIs screen and pushing an AI to a space (old src/person-spaces.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { openRecords } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
import { agentsFromAis, makeAis } from '../src/ais.mjs';
import { recordLogStore } from '../../keep-and-wake-ai-sessions-on-this-computer/parts/record-log/do-work/record-log-store.mjs';

// Old src/mcp-client-identity.mjs mcpSignInId: a key's own id, or an OAuth client's hashed id.
const hash = text => bytesToHex(blake3(new TextEncoder().encode(text)));
function mcpSignInId({ keyId, clientId } = {}) {
  if (typeof keyId === 'string' && keyId) return `key:${keyId}`;
  if (typeof clientId === 'string' && clientId) return `key:oauth-${hash(clientId).slice(0, 24)}`;
  return null;
}
// A store whose statements are counted, taken since the last take.
function countingHost() {
  const host = sqliteHost(':memory:');
  let seen = [];
  const sql = { exec: (query, ...args) => { seen.push(query); return host.sql.exec(query, ...args); } };
  return { host, sql, take: () => { const taken = seen; seen = []; return taken; } };
}

const fresh = (clock = { at: Date.parse('2026-10-10T10:00:00.000Z') }) => {
  const host = sqliteHost(':memory:');
  const records = openRecords(host.sql, { transaction: host.transaction });
  return { records, clock, ais: makeAis({ eeaf: records, now: () => new Date(clock.at).toISOString() }) };
};

test('every writer merges into one record per AI, and the person\'s order is kept', () => {
  const { ais, records } = fresh();
  const signIn = mcpSignInId({ clientId: 'claude-code-client' });
  ais.upsert(ais.fromClient(signIn, { name: 'Claude Code', client_name: 'claude-code' }));
  ais.upsert(ais.fromCard({ agent_id: 'take-open-work-macbook-pro-3', name: 'Codex on MacBook Pro 3', published_at: '2026-10-10T10:00:00.000Z', capacity: { ttl_minutes: 30 } }));
  ais.upsert({ key: 'claude-code', label: 'Claude Code', order: 1, order_set_by_person: true });
  ais.upsert(ais.fromClient(mcpSignInId({ keyId: 'k2' }), { name: 'Claude Code', client_name: 'claude-code' }));
  const list = ais.list();
  assert.deepEqual(list.map(ai => [ai.id, ai.kind, ai.order]), [['ai:claude-code', 'cli', 1], ['ai:take-open-work-macbook-pro-3', 'cli', 100]]);
  assert.deepEqual(list[0].sign_ins, [signIn, mcpSignInId({ keyId: 'k2' })], 'a second sign-in of the same AI joins its record');
  assert.deepEqual(list[1].can, ['any', 'code', 'files', 'mac-tools'], 'what a kind can do is data');
  // The computer it runs on is a record of its own, and what runs there is read the other way.
  assert.deepEqual(records.read('device:macbook-pro-3').label, 'macbook-pro-3');
  assert.deepEqual(records.holdersOf('device:macbook-pro-3').holders.map(holder => [holder.id, holder.role]), [['ai:take-open-work-macbook-pro-3', 'runs on']]);
  assert.deepEqual(records.holdersOf('take-open-work-macbook-pro-3').holders.map(holder => holder.role), ['agent']);
});

test('checking in often costs no row, and a trouble or a long silence is written', () => {
  const clock = { at: Date.parse('2026-10-10T10:00:00.000Z') };
  const { ais, records } = fresh(clock);
  const card = at => ({ agent_id: 'take-open-work-mini', name: 'Codex on Mini', published_at: new Date(at).toISOString() });
  ais.upsert(ais.fromCard(card(clock.at)));
  const rows = () => records.log({ record_id: 'ai:take-open-work-mini' }).length;
  const first = rows();
  ais.upsert(ais.fromCard(card(clock.at + 60_000)));
  assert.equal(rows(), first, 'a minute later: nothing written');
  ais.upsert(ais.fromCard({ ...card(clock.at + 120_000), trouble: 'codex not found in PATH' }));
  assert.equal(rows(), first + 1, 'trouble is written at once');
  assert.equal(ais.isLive(ais.get('take-open-work-mini'), clock.at + 120_000), false, 'an AI in trouble is not live');
  ais.upsert(ais.fromCard(card(clock.at + 30 * 60_000)));
  assert.equal(rows(), first + 2);
  assert.equal(ais.isLive(ais.get('take-open-work-mini'), clock.at + 31 * 60_000), true);
});

test('find_agents reads the one list: its AIs in the person\'s order, a card of an AI not on it left out, an AI with no card shown as not ready', async () => {
  const ais = [
    { id: 'ai:take-open-work-mini', agent_id: 'take-open-work-mini', label: 'Codex on Mini', kind: 'cli', order: 2 },
    { id: 'ai:claude-code', label: 'Claude Code', kind: 'cli', order: 1, live_now: true },
    { id: 'ai:sonnet-row', label: 'Sonnet', kind: 'account', order: 3 },
  ];
  const cards = new Set(['take-open-work-mini', 'ai:sonnet-row', 'retired-harness-card']);
  const agents = [
    { agent_id: 'retired-harness-card', match: 1 },
    { agent_id: 'ai:sonnet-row', match: 0.5 },
    { agent_id: 'take-open-work-mini', match: 0.5 },
  ];
  const found = agentsFromAis({ ais, agents, hasCard: id => cards.has(id) });
  assert.deepEqual(found.map(agent => [agent.agent_id, agent.ai_id, agent.ready_now ?? null]), [
    ['take-open-work-mini', 'ai:take-open-work-mini', null],
    ['ai:sonnet-row', 'ai:sonnet-row', null],
    ['claude-code', 'ai:claude-code', false],
  ], 'equal matches in the person\'s order; the card of no AI on the list is gone; Claude Code has no card and is still there');
  assert.match(found[2].why, /no agent card/);
});

test('a chat\'s card is one chat of the AI that published it, never an AI of its own; records made before are folded in', async () => {
  const { ais, records } = fresh();
  const signIn = mcpSignInId({ keyId: 'k-claude' });
  ais.upsert(ais.fromClient(signIn, { name: 'Claude Code', client_name: 'claude-code' }));
  const chat = n => ({ agent_id: `session-claude-code-${n}`, name: 'Claude Code', source_id: `claude-code:${n}`, reader: signIn, published_at: `2026-10-10T1${n}:00:00.000Z` });
  for (const n of [1, 2, 3]) { const input = ais.fromCard(chat(n)); if (input) ais.upsert(input); }
  const thread = { agent_id: '01a0ec44-fe2e', name: 'MCP tools & AI onboarding, tours', harness: 'Codex', reader: 'app:ChatGPT', published_at: '2026-10-10T09:00:00.000Z' };
  ais.upsert(ais.fromCard(thread));
  ais.upsert(ais.fromCard({ agent_id: 'take-open-work-mini', name: 'Codex on Mini', published_at: '2026-10-10T10:00:00.000Z' }));
  assert.deepEqual(ais.list().map(ai => ai.id).sort(), ['ai:chatgpt', 'ai:claude-code', 'ai:take-open-work-mini'], 'three chats are one AI; a ChatGPT thread is ChatGPT; a computer runner is its own AI');
  assert.equal(ais.get('claude-code').live.seen_at, '2026-10-10T13:00:00.000Z', 'its newest chat says when it was last seen');
  ais.upsert(ais.fromCard(chat(0)));
  assert.equal(ais.get('claude-code').live.seen_at, '2026-10-10T13:00:00.000Z', 'an older chat never moves it back');
  // find_agents still reaches one chat: its card belongs to its AI.
  const found = agentsFromAis({ ais: ais.list(), agents: [{ ...chat(2), match: 1 }], hasCard: () => false });
  assert.deepEqual(found.filter(agent => agent.ai_id === 'ai:claude-code').map(agent => agent.agent_id), ['session-claude-code-2']);
  // Records made one per chat before this rule fold into their AI, a bounded step at a time.
  const cards = new Map([[chat(7).agent_id, chat(7)], [chat(8).agent_id, chat(8)]]);
  records.write([...cards.keys()].map(id => ({ id: `ai:${id}`, type: 'ai', value: { label: 'Claude Code', kind: 'chat', agent_id: id, can: [], order: 100 } })));
  let step = { before: null, done: false }, folded = 0;
  for (let n = 0; !step.done && n < 10; n++) { step = ais.foldChats({ cardOf: id => cards.get(id) ?? null, before: step.before, limit: 2 }); folded += step.folded; }
  assert.equal(folded, 2);
  assert.deepEqual(ais.list().map(ai => ai.id).sort(), ['ai:chatgpt', 'ai:claude-code', 'ai:take-open-work-mini']);
  assert.equal(ais.get('claude-code').live.seen_at, '2026-10-10T18:00:00.000Z');
});

test('a fill of a client stored without its time never turns a live AI into one last seen at the epoch', () => {
  const { ais, clock } = fresh();
  const signIn = mcpSignInId({ clientId: 'sofus-client' });
  ais.upsert(ais.fromClient(signIn, { name: 'Sofus path proof', client_name: 'Sofus path proof' }));
  const live = ais.get('Sofus path proof').live.seen_at;
  assert.equal(live, new Date(clock.at).toISOString(), 'the introduction is what says it was seen, now');
  ais.upsert(ais.fromClient(signIn, { name: 'Sofus path proof', client_name: 'Sofus path proof' }, null), { actor: { by: 'ais-fill' } });
  assert.equal(ais.get('Sofus path proof').live.seen_at, live, 'the fill keeps the time it already had');
  assert.equal(ais.isLive(ais.get('Sofus path proof'), clock.at + 60_000), true);
  ais.upsert(ais.fromClient(mcpSignInId({ keyId: 'never-seen' }), { name: 'Never seen', client_name: 'never-seen' }, null));
  assert.equal(ais.get('Never seen').live, undefined, 'a client with no known time is not live, and is not dated 1970');
});

test('listing many AIs reads their records a page at a time, not one read per AI', () => {
  // Cold, from kept runs with no cache, as the service account's store reads them.
  const options = host => ({ transaction: host.host.transaction, runs: { page_bytes: 4096, cache_bytes: 0 }, slot_bytes: 4096 });
  const measured = count => {
    const host = countingHost();
    const writer = recordLogStore(host.sql, options(host));
    for (let start = 0; start < count; start += 100) writer.write(Array.from({ length: Math.min(100, count - start) }, (_, n) => ({ id: `ai:chat-${start + n}`, type: 'ai', value: { label: `Chat ${start + n}`, kind: 'chat' } })));
    writer.checkpoint();
    const ais = makeAis({ eeaf: recordLogStore(host.sql, options(host)), now: () => '2026-10-16T05:00:00.000Z' });
    host.take();
    const listed = ais.list();
    const statements = host.take().length;
    assert.equal(listed.length, count);
    return statements;
  };
  const few = measured(20);
  const many = measured(800);
  // The service account's ~1,000 AIs were read one by one, three times a call (2026-10-16: 7,389 statements, CPU reset).
  // Pages of 100 ids: about six statements a page cold (800 AIs: 51), never one a record (803 before).
  assert.ok(many <= 800 / 10, JSON.stringify({ few, many }));
});
