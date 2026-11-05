// Ported from old trillion test/own-ais.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. pick, liveness, needs and migrate are src/own-ais.mjs here, the rows makeAis
// (tools/see-and-limit-what-each-ai-can-reach/src/ais.mjs). Old src/own-ais-routing.mjs, the loop that gave waiting work
// to a row, marked it no_taker and kept the person's ceiling through limitSync, has no home in any repository (searched
// ownAisRouting, own-ais-routing, limitSync, no_taker in trillion-workshop tools/, trillion-rust src/, trillion-apps web/):
// its four tests (a waiting MCP client, a cli row by address, no_taker with reasons, the ceiling kept through the routing)
// and the ceiling test's check that the routing has limitSync are left out; that test's pick and covers checks are kept.
// The person's own AIs: which one takes waiting work (pick), which are live, what each can do, how a row is written
// (makeAis, src/ais.mjs) and read back in order, how an earlier choice becomes rows (migrate), and how the routing
// gives a job to a row or marks it no_taker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pick, isLive, liveProblem, covers, needsOf, noTakerWords, migrate } from '../src/own-ais.mjs';
import { makeAis } from '../../see-and-limit-what-each-ai-can-reach/src/ais.mjs';
import aisData from '../src/ais.json' with { type: 'json' };
import settings from '../src/own-ais.json' with { type: 'json' };

const NOW = new Date('2026-10-10T12:00:00.000Z');
const minutesAgo = minutes => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const later = minutes => new Date(NOW.getTime() + minutes * 60_000).toISOString();

const row = (id, kind, extra = {}) => ({
  id, agent_id: id, label: id, kind, order: 0, can: [...(settings.kinds[kind]?.can ?? [])],
  live: { seen_at: minutesAgo(1), how: 'test' }, spends: settings.kinds[kind]?.spends ?? 'none', ...extra,
});
const cli = (id, extra = {}) => row(id, 'cli', { runs_on: { device: 'device:mac', place: settings.placement_computer }, ...extra });
const device = (id, extra = {}) => row(id, 'device-model', { tool_id: 'tool:ask-a-model', model: 'local', runs_on: { device: null, place: settings.placement_computer }, ...extra });
const account = (id, extra = {}) => row(id, 'account', { tool_id: 'tool:ask-anthropic-chat', model: 'claude-sonnet-5', runs_on: { device: null, place: 'cloud' }, ...extra });

// An in-memory record store with the three calls src/ais.mjs makes: read(id), write(records), ids(type).
const ais = eeaf => makeAis({ eeaf, now: () => NOW.toISOString() });

function memoryRecords() {
  const kept = new Map();
  return {
    kept,
    read: id => kept.get(id)?.value ?? null,
    write: records => { for (const record of records) kept.set(record.id, record); },
    ids: type => [...kept.values()].filter(record => record.type === type).map(record => record.id),
  };
}

test('pick takes the first live row, in the order given, that can do the job', () => {
  const rows = [cli('ai:a', { order: 0, live: { seen_at: null, how: 'test' } }), device('ai:b', { order: 1 }), account('ai:c', { order: 2 })];
  const { row: took, reasons } = pick({ input: {} }, rows, NOW);
  assert.equal(took.id, 'ai:b', 'the first live row takes it; the earlier one is not live');
  assert.equal(reasons.length, 0);
});

test('subscription work uses any addressed AI without rerouting through local or metered models', () => {
  const models = [device('ai:local', { can: ['any'] }), account('ai:api', { can: ['any'] })];
  const job = { input: { needs: ['subscription-ai'] } };
  assert.equal(pick(job, models, NOW).row, null, 'a model cannot claim an execution capability with any');
  for (const agent of [cli('connected-codex'), row('connected-chat', 'chat'), cli('another-subscription')])
    assert.equal(pick(job, [...models, agent], NOW).row.agent_id, agent.agent_id);
  assert.deepEqual(needsOf({ from_agent: 'trillion-model-road' }), ['subscription-ai'], 'existing carriers retain their semantic requirement');
  assert.deepEqual(needsOf({ from_agent: 'trillion-model-road', input: { needs: ['code'] } }), ['code'], 'explicit requirements remain the source of truth');
});

test('pick skips a row that is not live and says why', () => {
  const rows = [account('ai:old', { live: { seen_at: minutesAgo(60 * 48), how: 'test' } })];
  const { row: took, reasons } = pick({ input: {} }, rows, NOW);
  assert.equal(took, null);
  assert.equal(reasons[0].id, 'ai:old');
  assert.match(reasons[0].why, /last seen/);
});

test('connected clients without a work recipient do not receive jobs, and a later registered AI can', () => {
  for (const kind of Object.keys(settings.kinds)) {
    for (const agent_id of [undefined, null, '', '   ']) {
      const connectedOnly = row('ai:connected-client', kind, { agent_id, tool_id: 'tool:ask-a-model' });
      const result = pick({ input: {} }, [connectedOnly], NOW);
      assert.equal(result.row, null);
      assert.equal(result.reasons[0].why, 'it has no registered work recipient');
      assert.equal(pick({ input: {} }, [connectedOnly, cli('actual-recipient')], NOW).row.agent_id, 'actual-recipient');
    }
  }
});

test('a row whose trouble has not passed is not live; one whose trouble has passed is', () => {
  const troubled = account('ai:t', { live: { seen_at: minutesAgo(1), how: 'test', trouble: { why: 'out of credit', until: later(30) } } });
  assert.equal(isLive(troubled, NOW), false);
  assert.equal(liveProblem(troubled, NOW), 'out of credit');
  const healed = account('ai:h', { live: { seen_at: minutesAgo(1), how: 'test', trouble: { why: 'out of credit', until: minutesAgo(5) } } });
  assert.equal(isLive(healed, NOW), true);
});

test('a row whose kind this account cannot use is not live', () => {
  assert.match(liveProblem(row('ai:x', 'retired-kind'), NOW), /kind/);
});

test('a code job never goes to a device-model or account row; a cli row takes it', () => {
  const needs = ['code'];
  assert.equal(covers(device('ai:d'), needs), false);
  assert.equal(covers(account('ai:c'), needs), false);
  assert.equal(covers(cli('ai:k'), needs), true);
  const job = { input: { needs } };
  const { row: took } = pick(job, [device('ai:d', { order: 0 }), account('ai:c', { order: 1 }), cli('ai:k', { order: 2 })], NOW);
  assert.equal(took.id, 'ai:k');
  const none = pick(job, [device('ai:d', { order: 0 }), account('ai:c', { order: 1 })], NOW);
  assert.equal(none.row, null);
  assert.deepEqual(none.reasons.map(item => item.id), ['ai:d', 'ai:c']);
});

test('needs default to the data default, and "any" covers every need', () => {
  assert.deepEqual(needsOf({ input: {} }), settings.default_needs);
  assert.equal(covers(cli('ai:k'), ['any']), true);
  assert.equal(covers(row('ai:w', 'device-model', { can: ['any'] }), ['code', 'files']), true);
});

test('no row fits: the reasons name each row, and the no_taker words carry them', () => {
  const { row: took, reasons } = pick({ input: { needs: ['read'] } }, [cli('ai:k', { label: 'My Mac', can: ['code'] })], NOW);
  assert.equal(took, null);
  const words = noTakerWords(reasons);
  assert.match(words, /My Mac/);
  assert.match(words, /cannot do read/);
  assert.equal(noTakerWords([]), settings.words.none_yet);
});

test('upsertAi writes a type ai record for a cli row with its trouble, and that row is not live', () => {
  const eeaf = memoryRecords();
  const made = ais(eeaf).upsert({
    key: 'take-open-work-mac1', label: 'Avery\'s Mac', kind: 'cli', agent_id: 'ai:take-open-work-mac1',
    can: [...settings.kinds.cli.can], runs_on: { device: 'device:mac1', place: settings.placement_computer },
    live: { seen_at: minutesAgo(2), how: 'test', trouble: { why: 'the disk is full' } },
  });
  assert.equal(made.id, 'ai:take-open-work-mac1');
  assert.equal(eeaf.kept.get('ai:take-open-work-mac1').type, 'ai');
  assert.equal(isLive(made, NOW), false);
  assert.equal(liveProblem(made, NOW), 'the disk is full');
});

test('upsert keeps the order the person set when a row is written again, and a new row takes the data default', () => {
  const eeaf = memoryRecords();
  const first = ais(eeaf).upsert({ key: 'k', label: 'K', kind: 'cli', order: 3, live: { seen_at: minutesAgo(1), how: 'test' } });
  assert.equal(first.order, 3);
  const again = ais(eeaf).upsert({ key: 'k', label: 'K renamed', kind: 'cli', live: { seen_at: minutesAgo(1), how: 'test' } });
  assert.equal(again.order, 3, 'written again without an order, the row keeps its order');
  assert.equal(again.label, 'K renamed');
  assert.deepEqual(again.can, aisData.can_by_kind.cli, 'a row with no can takes the default for its kind');
  const newer = ais(eeaf).upsert({ key: 'c', label: 'C', kind: 'account', live: { seen_at: minutesAgo(1), how: 'test' } });
  assert.equal(newer.order, aisData.order_default, 'a new row with no order takes the data default');
  const before = eeaf.kept.get('ai:c');
  ais(eeaf).upsert({ key: 'c', label: 'C', kind: 'account', live: { seen_at: minutesAgo(1), how: 'test' } });
  assert.equal(eeaf.kept.get('ai:c'), before, 'nothing changed: nothing written');
});

test('remove takes a row out of the one list: list and get leave it out', () => {
  const eeaf = memoryRecords();
  ais(eeaf).upsert({ key: 'k', label: 'K', kind: 'cli', live: { seen_at: minutesAgo(1), how: 'test' } });
  assert.equal(ais(eeaf).list().length, 1);
  ais(eeaf).remove('k');
  assert.equal(ais(eeaf).get('k'), null);
  assert.equal(ais(eeaf).list().length, 0);
  assert.equal(eeaf.kept.get('ai:k').value, null, 'the record is written empty (src/ais.mjs remove)');
});

test('migrate writes an earlier local choice as one device-model row through upsertAi, and does not write it twice', () => {
  const eeaf = memoryRecords();
  const made = migrate(ais(eeaf), { providers: [{ provider: 'local' }] }, NOW);
  assert.equal(made.length, 1);
  assert.equal(made[0].kind, 'device-model');
  assert.equal(made[0].id, 'ai:local');
  assert.equal(made[0].runs_on.place, settings.placement_computer);
  assert.equal(eeaf.kept.get('ai:local').type, 'ai');
  assert.equal(migrate(ais(eeaf), { providers: [{ provider: 'local' }] }, NOW).length, 0, 'a row already kept is not made again');
  assert.equal(ais(eeaf).list().length, 1);
});

test('rows reads kept rows in the person\'s order', () => {
  const eeaf = memoryRecords();
  ais(eeaf).upsert({ key: 'c', label: 'C', kind: 'account', order: 2, can: [...settings.kinds.account.can], runs_on: { device: null, place: 'cloud' }, live: { seen_at: minutesAgo(1), how: 'test' } });
  ais(eeaf).upsert({ key: 'k', label: 'K', kind: 'cli', order: 0, can: [...settings.kinds.cli.can], runs_on: { device: 'device:k', place: settings.placement_computer }, live: { seen_at: minutesAgo(1), how: 'test' } });
  assert.deepEqual(ais(eeaf).list().map(item => item.id), ['ai:k', 'ai:c']);
});

test('a ceiling on an AI refuses the work it denies where AIs are admitted (pick) and an automation job can only tighten it', async () => {
  const rows = [cli('ai:a', { order: 0, can: ['any', 'code', 'files'], ceiling: { deny: ['files'] } }), cli('ai:b', { order: 1, can: ['any', 'code', 'files'] })];
  assert.equal(pick({ input: { needs: ['files'] } }, rows, NOW).row.id, 'ai:b');
  const none = pick({ input: { needs: ['files'] } }, [rows[0]], NOW);
  assert.equal(none.row, null);
  assert.match(none.reasons[0].why, /ceiling denies files/);
  assert.equal(pick({ input: { needs: ['code'] } }, rows, NOW).row.id, 'ai:a', 'work the ceiling does not name goes to the first AI');
  assert.equal(pick({ input: { needs: ['code'], ceiling: { deny: ['code'] } } }, rows, NOW).row, null, 'a job ceiling tightens every AI it reaches');
  assert.equal(covers(rows[1], ['files'], { input: { ceiling: { deny: ['files'] } } }), false);
  assert.equal(covers(rows[0], ['code'], { input: { ceiling: { allow: ['code', 'files'] } } }), true, 'a wider ask does not lift a denial, and allowing what is already allowed changes nothing');
  assert.equal(covers(rows[0], ['files'], { input: { ceiling: { allow: ['files'] } } }), false, 'a job cannot widen past the AI ceiling');
});
