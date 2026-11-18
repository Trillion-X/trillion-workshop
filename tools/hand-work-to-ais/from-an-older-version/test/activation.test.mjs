// How handing work starts an agent (src/activation.mjs): starts_now, busy, offline and unsupported stay distinct.
import test from 'node:test';
import assert from 'node:assert/strict';
import { activationOf, bindingFrom } from '../src/activation.mjs';

const now = new Date('2026-09-30T10:00:00Z');
const agent = { agent_id: 'chatgpt-work', reader: 'app:ChatGPT', delivery: null, last_seen_at: null };
const subscription = { id: 'sub_1', name: 'work.waiting', arguments: {}, reader: 'app:ChatGPT', expires_at: '2026-10-07T10:00:00Z' };

test('a chat subscribed to work events starts now, or is busy when its capacity is full', () => {
  assert.equal(activationOf({ agent, subscriptions: [subscription], now }).state, 'starts_now');
  assert.equal(activationOf({ agent, subscriptions: [subscription], now }).path, 'chat-events');
  assert.equal(activationOf({ agent, capacity: { status: 'full' }, subscriptions: [subscription], now }).state, 'busy');
  assert.equal(activationOf({ agent: { ...agent, reader: 'app:Other' }, subscriptions: [subscription], now }).state, 'unsupported');
  assert.equal(activationOf({ agent: { ...agent, reader: 'app:Other' }, subscriptions: [{ ...subscription, arguments: { agent_id: 'chatgpt-work' } }], now }).state, 'starts_now');
});

test('a desktop connection is live within its contact window, offline after it, and unsupported when its host says so', () => {
  const card = { ...agent, agent_id: 'codex-desk', reader: 'key:k1' };
  const fresh = bindingFrom({ agent_id: 'codex-desk', host: 'codex', session: 'thread-1' }, card, new Date('2026-09-30T09:59:00Z'));
  assert.equal(activationOf({ agent: card, binding: fresh, now }).state, 'starts_now');
  assert.equal(activationOf({ agent: card, binding: { ...fresh, last_contact_at: '2026-09-30T09:40:00Z' }, now }).state, 'offline');
  const refused = bindingFrom({ agent_id: 'codex-desk', host: 'claude', supported: false, reason: 'Started without the channel.' }, card, now);
  const answer = activationOf({ agent: card, binding: refused, now });
  assert.equal(answer.state, 'unsupported');
  assert.equal(answer.detail.reason, 'Started without the channel.');
  assert.throws(() => bindingFrom({ agent_id: 'nobody' }, null), /No agent nobody/);
});

test('an agent with no way to be started is unsupported, and one with a delivery address is offline until seen', () => {
  assert.equal(activationOf({ agent, now }).state, 'unsupported');
  assert.equal(activationOf({ agent, now }).path, null);
  const addressed = { ...agent, delivery: { url: 'https://agent.example.com/events' } };
  assert.equal(activationOf({ agent: addressed, now }).state, 'offline');
  assert.equal(activationOf({ agent: { ...addressed, last_seen_at: '2026-09-30T09:55:00Z' }, now }).state, 'starts_now');
});
