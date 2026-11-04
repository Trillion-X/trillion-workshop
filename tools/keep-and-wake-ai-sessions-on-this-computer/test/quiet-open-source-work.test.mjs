// Work already waiting from a source that got quieter is put through that source's current rule once
// (harness/quiet-open-source-work.mjs): what the rule leaves out is closed as skipped, the rest folded into one summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { foldPlan, runFold } from '../harness/quiet-open-source-work.mjs';
import settings from '../harness/quiet-open-source-work.json' with { type: 'json' };
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';

const source = { id: 'events:shop', label: 'A shop', events: [{ name: 'sale' }, { name: 'refund' }],
  default_rule: { skip: [{ field: 'email', matches: '^proof-[0-9]+@example\\.com$' }], batch: { every_minutes: 1440 } } };
const loud = { id: 'events:loud', label: 'Loud', events: [{ name: 'ping' }] };
const shape = { batch_job: 'Activity on {source_label} over {hours} hours ({event}).' };
const NOW = '2026-09-30T12:00:00.000Z';
const job = (id, arrived, extra = {}) => ({ handoff_id: id, state: 'open', to_agent: null, handed_at: `2026-09-30T0${id.slice(-1)}:00:00.000Z`, input: { arrived }, ...extra });

test('the plan closes what the rule leaves out and folds the rest of each event into one summary', () => {
  const open = [
    job('h1', { source: 'A shop', event: 'sale', email: 'proof-1234@example.com' }),
    job('h2', { source: 'A shop', event: 'sale', email: 'someone@example.org' }),
    job('h3', { source: 'A shop', event: 'sale', email: 'other@example.org' }),
    job('h4', { source: 'A shop', event: 'refund', email: 'x@example.org' }),
    job('h5', { source: 'Loud', event: 'ping' }),
    job('h6', { source: 'A shop', event: 'sale', email: 'named@example.org' }, { to_agent: 'someone' }),
    job('h7', { source: 'A shop', event: 'sale', email: 'held@example.org' }, { state: 'taken', hold_until: '2026-09-30T13:00:00.000Z' }),
  ];
  const { skip, fold } = foldPlan({ open, sources: [source, loud], shape, now: NOW });
  assert.deepEqual(skip.map(item => item.handoff_id), ['h1']);
  assert.equal(fold.length, 1, 'a kind of event with one job left is left as it is');
  assert.deepEqual(fold[0].ids, ['h2', 'h3']);
  assert.equal(fold[0].job, 'Activity on A shop over 24 hours (sale).');
  assert.equal(fold[0].arrived.count, 2);
  assert.equal(fold[0].arrived.events[1].email, 'other@example.org');
});

test('the pass closes and folds on the account, and a second pass changes nothing', async () => {
  const agents = makeAgents({ store: agentStoreForTests(), now: () => new Date(NOW) });
  for (const [key, email] of [['a', 'proof-99@example.com'], ['b', 'b@example.org'], ['c', 'c@example.org']])
    agents.handOff({ job: `sale ${key}`, request_key: key, input: { arrived: { source: 'A shop', event: 'sale', email } } });
  const routes = { '/agents/publish': 'publish', '/handoffs': 'handOff', '/handoffs/take': 'take', '/handoffs/finish': 'finish' };
  const call = async (path, body) => (path === '/tools/run' ? { output: { work: agents.board({ limit: 50 }).work ?? agents.read().handoffs } } : agents[routes[path]](body));
  const first = await runFold({ call, settings, sources: [source], shape, now: () => new Date(NOW) });
  assert.deepEqual(first.problems, []);
  assert.equal(first.skipped.length, 1);
  assert.equal(first.folded[0].ids.length, 2);
  assert.deepEqual(first.problems, []);
  const summary = agents.read({ handoff_id: first.folded[0].into }).handoff;
  assert.equal(summary.state, 'open');
  assert.equal(summary.input.arrived.count, 2);
  const again = await runFold({ call, settings, sources: [source], shape, now: () => new Date(NOW) });
  assert.equal(again.skipped.length + again.folded.length, 0);
});
