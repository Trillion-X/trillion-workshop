import assert from 'node:assert/strict';
import test from 'node:test';
import { loadChoices, modelsOf, sqlThrough } from '../read-data/load-choices.mjs';

const fakeSql = answers => async (store, sql) => {
  assert.equal(store, 'store-a');
  const key = Object.keys(answers).find(words => sql.includes(words));
  return answers[key];
};
const noCodex = async () => { throw new Error('no codex-lb'); };

test('the loader reads choice, limit and cool-down rows from the store it is given, and the models from the doors', async () => {
  const runSql = fakeSql({
    'answerer-choice': [{ value: JSON.stringify({ id: 'codex-answer', provider: 'codex', kinds: ['ai'], models: ['m1'] }) }, { value: '{"provider":"claude"}' }],
    'from provider_limits': [{ provider: 'claude', account: 'claude pool 1', window_name: 'weekly', used_percent: 10, state: 'ok' }],
    'cooldown/': [{ value: JSON.stringify({ provider: 'codex', account: 'codex-lb account 1', until: '2026-11-22T10:00:00Z' }) }],
  });
  const fetchImpl = async url => ({ ok: true, json: async () => ({ data: url.includes('2455') ? [{ id: 'm1' }] : [{ id: 'c1' }] }) });
  const choices = await loadChoices({ store: 'store-a', doors: { codex: 'http://127.0.0.1:2455', claude: 'http://127.0.0.1:9000' }, runSql, fetchImpl,
    readCodex: async () => [{ provider: 'codex', account: 'codex-lb account 1', window_name: 'weekly', used_percent: 2, state: 'ok' }] });
  assert.deepEqual(choices.providers.map(row => row.id), ['codex-answer']);
  assert.deepEqual(choices.models, { codex: ['m1'], claude: ['c1'] });
  assert.equal(choices.limits.find(row => row.provider === 'codex').used_percent, 2, 'a fresh codex-lb reading replaces the stored one');
  assert.equal(choices.limits.some(row => row.provider === 'claude'), true);
  assert.deepEqual(choices.cooldowns, [{ provider: 'codex', account: 'codex-lb account 1', until: '2026-11-22T10:00:00Z' }]);
});

test('with no door given, no model is named and the stored limits stand', async () => {
  const runSql = fakeSql({ 'answerer-choice': [], 'from provider_limits': [{ provider: 'codex', account: 'a', window_name: 'weekly', used_percent: 5, state: 'ok' }], 'cooldown/': [] });
  const choices = await loadChoices({ store: 'store-a', runSql, readCodex: noCodex });
  assert.deepEqual(choices.models, { codex: [], claude: [] });
  assert.equal(choices.limits[0].used_percent, 5);
});

test('a door that does not answer gives no models', async () => {
  assert.deepEqual(await modelsOf('http://127.0.0.1:9', { fetchImpl: async () => { throw new Error('refused'); } }), []);
});

test('the loader refuses to run with no store named', async () => {
  await assert.rejects(loadChoices({}), /needs the store/);
  await assert.rejects(loadChoices({ store: 'store-a' }), /needs runSql/);
  assert.equal(typeof sqlThrough(['echo']), 'function');
});

test('against the real rows of a store (when a SQL command is named in the environment)', async t => {
  const words = process.env.ANSWER_SQL_COMMAND ? JSON.parse(process.env.ANSWER_SQL_COMMAND) : null;
  if (!words) return t.skip('no ANSWER_SQL_COMMAND set (a JSON argv for the store SQL command)');
  const store = process.env.ANSWER_STORE;
  if (!store) return t.skip('no ANSWER_STORE set (the store to read)');
  const choices = await loadChoices({ store, runSql: sqlThrough(words), doors: { codex: 'http://127.0.0.1:2455' } });
  assert.ok(choices.providers.some(row => row.provider === 'codex' && row.kinds.includes('ai')), 'the codex answerer row is there');
  assert.ok(choices.limits.some(row => row.provider === 'codex' && row.window_name === 'weekly'), 'codex weekly rows are there');
  assert.ok(choices.models.codex.length > 0, 'codex-lb lists its models');
});
