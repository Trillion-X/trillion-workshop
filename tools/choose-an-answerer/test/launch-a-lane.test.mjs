import assert from 'node:assert/strict';
import test from 'node:test';
import { launchALane, commandFor } from '../read-data/launch-a-lane.mjs';

const providers = [
  { id: 'codex-answer', provider: 'codex', kinds: ['ai'], fit: [], weight: 2, enabled: true, prefer_below_percent: 50, account_pool: ['codex-lb account 1', 'codex-lb account 2'], models: ['gpt-6.2-sol'] },
  { id: 'claude-answer', provider: 'claude', kinds: ['ai'], fit: [], weight: 1, enabled: true, account_pool: ['claude pool 1'], models: ['claude-x'] },
];
const models = { codex: ['gpt-6.2-sol'], claude: ['claude-x'] };
const limit = (account, used) => ({ provider: account.startsWith('claude') ? 'claude' : 'codex', account, window_name: 'weekly', used_percent: used, state: 'ok' });

test('Codex is the default while its weekly room is above 50%, and the brief goes on stdin, not argv', async () => {
  const calls = [];
  const result = await launchALane({ brief: 'Write the summary', dir: '/work/lane', resultFile: '/work/lane/result.md', providers, models,
    limits: [limit('codex-lb account 1', 2), limit('codex-lb account 2', 3), limit('claude pool 1', 10)],
    run: async call => { calls.push(call); return { exit_code: 0 }; } });
  assert.equal(result.provider, 'codex');
  assert.equal(result.account, 'codex-lb account 1');
  assert.equal(calls[0].stdin, 'Write the summary');
  assert.equal(calls[0].argv.includes('Write the summary'), false);
  assert.deepEqual(calls[0].argv.slice(0, 2), ['codex', 'exec']);
});

test('when Codex is over its 50% preference, a Claude chat takes the brief and the why says so', async () => {
  const calls = [];
  const result = await launchALane({ brief: 'x', dir: '/work/lane', resultFile: '/work/lane/r', providers, models,
    limits: [limit('codex-lb account 1', 60), limit('codex-lb account 2', 62), limit('claude pool 1', 10)],
    run: async call => { calls.push(call); return { exit_code: 0 }; } });
  assert.equal(result.provider, 'claude');
  assert.equal(calls[0].argv[0], 'claude');
  assert.match(result.why, /claude-answer: 10% used on claude pool 1/);
});

test('no room anywhere starts nothing and says why', async () => {
  let started = false;
  const result = await launchALane({ brief: 'x', dir: '/w', resultFile: '/w/r', providers, models,
    limits: [limit('codex-lb account 1', 99), limit('codex-lb account 2', 99), limit('claude pool 1', 99)],
    run: async () => { started = true; return { exit_code: 0 }; } });
  assert.equal(started, false);
  assert.match(result.none, /at or over 85%/);
});

test('an unknown provider has no command', () => {
  assert.throws(() => commandFor({ provider: 'other', model: 'm' }, { dir: '/w', resultFile: '/w/r' }), /no command is known/);
});
