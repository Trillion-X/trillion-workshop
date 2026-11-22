import assert from 'node:assert/strict';
import test from 'node:test';
import { cli } from '../read-data/launch-a-lane.mjs';

const providers = [
  { id: 'codex-answer', provider: 'codex', kinds: ['ai'], fit: [], weight: 2, enabled: true, prefer_below_percent: 50, account_pool: ['codex-lb account 1'], models: ['gpt-6.2-sol'] },
];
const loader = limits => async () => ({ providers, limits, models: { codex: ['gpt-6.2-sol'] }, cooldowns: [] });
const base = ['--store', 'store-a', '--sql-command', '["cmd"]'];

test('--pick-only prints the pick and starts nothing', async () => {
  const pick = await cli([...base, '--pick-only'], '', { loadChoices: loader([{ provider: 'codex', account: 'codex-lb account 1', window_name: 'weekly', used_percent: 3, state: 'ok' }]) });
  assert.deepEqual(pick, { provider: 'codex', account: 'codex-lb account 1', model: 'gpt-6.2-sol', why: 'codex-answer: 3% used on codex-lb account 1' });
});

test('--pick-only prints none in words when nothing has room', async () => {
  const pick = await cli([...base, '--pick-only', '--kind', 'embed'], '', { loadChoices: loader([]) });
  assert.match(pick.none, /No answerer row fits the need/);
});

test('a real start still needs --dir and --result', async () => {
  await assert.rejects(cli(base, 'brief', { loadChoices: loader([]) }), /usage:/);
});
