// The tool choices find offered and a run chose among (src/tool-choices.mjs): kept as the account's own training pairs,
// and pooled as a content-free choice set only while the account shares what it decides (src/sharing-choice.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { toolChoices } from '../src/tool-choices.mjs';

function account({ shares }) {
  const settings = new Map(), pooled = [];
  const store = { setting: name => settings.get(name) ?? null, setSetting: (name, value) => { if (value === null) settings.delete(name); else settings.set(name, value); return value; },
    settings: prefix => [...settings].filter(([name]) => name.startsWith(prefix)).map(([name, value]) => ({ name, value })) };
  const keep = { due: () => false, noted: () => {} };
  const choices = toolChoices({ store, keep, keepsOffers: async () => true, shares: async () => shares, pooled: async set => { pooled.push(set); } });
  return { choices, pooled };
}
const job = 'keep the rows that match';
const offered = { candidates: [{ tool_id: 'tool:a', label: 'A', job: 'does a' }, { tool_id: 'tool:b', label: 'B', job: 'does b' }] };

test('an account that shares pools one content-free choice set for the tool it ran among those offered', async () => {
  const { choices, pooled } = account({ shares: true });
  await choices.offered({ job }, offered);
  await choices.ran({ job, tool_id: 'tool:b' }, { state: 'completed' });
  assert.equal(pooled.length, 1);
  assert.deepEqual(Object.keys(pooled[0]).sort(), ['candidate_count', 'choice_key', 'chosen_index', 'method', 'source']);
  assert.equal(pooled[0].chosen_index, 1);
  assert.equal(choices.chosen()[0].chosen_id, 'tool:b');
});

test('an account that does not share keeps its own training pair and pools nothing', async () => {
  const { choices, pooled } = account({ shares: false });
  await choices.offered({ job }, offered);
  await choices.ran({ job, tool_id: 'tool:b' }, { state: 'completed' });
  assert.deepEqual(pooled, [], 'nothing of its choice leaves the account');
  assert.equal(choices.chosen()[0].chosen_id, 'tool:b', 'the account still has its own training pair');
});
