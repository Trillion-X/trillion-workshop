import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseAnswerer } from '../read-data/choose-an-answerer.mjs';

const providers = [
  { id: 'codex-answer', provider: 'codex', kinds: ['ai', 'anyone'], fit: ['text'], weight: 2, enabled: true, account_pool: ['codex-lb account 1', 'codex-lb account 2'], models: ['gpt-6.2-sol'] },
  { id: 'claude-answer', provider: 'claude', kinds: ['ai', 'anyone'], fit: ['text'], weight: 1, enabled: true, account_pool: ['claude pool 1'], models: ['claude-x'] },
];
const models = { codex: ['gpt-6.2-sol'], claude: ['claude-x'] };
const limit = (account, used, extra = {}) => ({ provider: account.startsWith('claude') ? 'claude' : 'codex', account, window_name: 'weekly', used_percent: used, state: 'ok', ...extra });
const now = new Date('2026-11-21T21:00:00Z');

test('the highest-weight provider with room answers, with its live model', () => {
  const pick = chooseAnswerer({ kind: 'ai', fit: ['text'] }, { providers, models, now, limits: [limit('codex-lb account 1', 1), limit('codex-lb account 2', 2), limit('claude pool 1', 5)] });
  assert.deepEqual(pick, { provider: 'codex', account: 'codex-lb account 1', model: 'gpt-6.2-sol', why: 'codex-answer: 1% used on codex-lb account 1' });
});

test('an account at or over 85% is skipped and the next account or provider answers', () => {
  const pick = chooseAnswerer({ kind: 'ai', fit: ['text'] }, { providers, models, now, limits: [limit('codex-lb account 1', 85), limit('codex-lb account 2', 90), limit('claude pool 1', 5)] });
  assert.equal(pick.provider, 'claude');
  assert.equal(pick.model, 'claude-x');
});

test('an unknown reading or a limited state is never a free pass', () => {
  const none = chooseAnswerer({ kind: 'ai', fit: ['text'] }, { providers: [providers[0]], models, now, limits: [limit('codex-lb account 1', null, { state: 'unknown' }), limit('codex-lb account 2', 10, { state: 'limited' })] });
  assert.match(none.none, /no reading/);
  assert.match(none.none, /at or over 85%/);
});

test('a cool-down still in force skips the account until it passes', () => {
  const cooldowns = [{ provider: 'codex', account: 'codex-lb account 1', until: '2026-11-21T22:00:00Z' }];
  const pick = chooseAnswerer({ kind: 'ai', fit: ['text'] }, { providers: [providers[0]], models, now, cooldowns, limits: [limit('codex-lb account 1', 1), limit('codex-lb account 2', 2)] });
  assert.equal(pick.account, 'codex-lb account 2');
});

test('a model not on the live list is never picked, and no fit gives none in words', () => {
  const pick = chooseAnswerer({ kind: 'ai', fit: ['text'] }, { providers: [providers[0]], models: { codex: [] }, now, limits: [limit('codex-lb account 1', 1)] });
  assert.match(pick.none, /none of its models is on the live list/);
  assert.match(chooseAnswerer({ kind: 'embed' }, { providers, models, now }).none, /No answerer row fits/);
});

test('a reviewer avoids the maker\'s provider while another provider has room', () => {
  const pick = chooseAnswerer({ kind: 'ai', fit: ['text'], role: 'reviewer', avoid: { provider: 'codex', model: 'gpt-6.2-sol' } },
    { providers, models, now, limits: [limit('codex-lb account 1', 1), limit('codex-lb account 2', 2), limit('claude pool 1', 60)] });
  assert.equal(pick.provider, 'claude');
  assert.equal(pick.model, 'claude-x');
});

test('when only the maker\'s provider has room, a reviewer takes another model of it and says so', () => {
  const codexTwo = { ...providers[0], models: ['gpt-6.2-sol', 'gpt-6.1-sol'] };
  const liveModels = { codex: ['gpt-6.2-sol', 'gpt-6.1-sol'], claude: ['claude-x'] };
  const pick = chooseAnswerer({ kind: 'ai', fit: ['text'], role: 'reviewer', avoid: { provider: 'codex', model: 'gpt-6.2-sol' } },
    { providers: [codexTwo, { ...providers[1], enabled: false }], models: liveModels, now, limits: [limit('codex-lb account 1', 1)] });
  assert.equal(pick.provider, 'codex');
  assert.equal(pick.model, 'gpt-6.1-sol');
  assert.match(pick.why, /reviewer: the maker's provider codex was the only one with room/);
});

test('a reviewer with only the maker\'s model available gets none, not the maker\'s model', () => {
  const pick = chooseAnswerer({ kind: 'ai', fit: ['text'], role: 'reviewer', avoid: { provider: 'codex', model: 'gpt-6.2-sol' } },
    { providers: [providers[0], { ...providers[1], enabled: false }], models, now, limits: [limit('codex-lb account 1', 1)] });
  assert.match(pick.none, /other than the maker's/);
});

test('a row over its preference loses to another row under the threshold, and is taken when no other row has room', () => {
  const codex = { ...providers[0], prefer_below_percent: 50 };
  const under = chooseAnswerer({ kind: 'ai', fit: ['text'] }, { providers: [codex, providers[1]], models, now, limits: [limit('codex-lb account 1', 60), limit('codex-lb account 2', 60), limit('claude pool 1', 10)] });
  assert.equal(under.provider, 'claude');
  const fallback = chooseAnswerer({ kind: 'ai', fit: ['text'] }, { providers: [codex, { ...providers[1], enabled: false }], models, now, limits: [limit('codex-lb account 1', 60), limit('codex-lb account 2', 70)] });
  assert.equal(fallback.account, 'codex-lb account 1');
  assert.match(fallback.why, /over its 50% preference, taken because no other row has room under 85%/);
});

test('a row under its preference is taken before a row with no preference', () => {
  const codex = { ...providers[0], prefer_below_percent: 50 };
  const pick = chooseAnswerer({ kind: 'ai', fit: ['text'] }, { providers: [codex, providers[1]], models, now, limits: [limit('codex-lb account 1', 20), limit('claude pool 1', 1)] });
  assert.equal(pick.provider, 'codex');
});
