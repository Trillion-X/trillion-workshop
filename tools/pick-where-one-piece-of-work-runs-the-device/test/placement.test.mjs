// Where work for a person runs is DATA (src/placement.json): the device that captured it, an awake device of theirs,
// the device they open it on, and Trillion's own machines only inside a budget the person set.
// Evaluated through the real formula engine, as the store does.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import { makeRowFilter } from '../../formula-engine/rules/filter-rows-by-rules.mjs';
import { devicesAwake, placeFor, placementFacts, trillionBudgetDollars } from '../src/placement.mjs';

const wasm = () => readFileSync(new URL('../../formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url));
const { filterRowsByRules } = makeRowFilter({ operators, wasm });
const matches = async (tree, facts) => (await filterRowsByRules({ tree, fields: placementFacts, rows: [facts] })).matches.length === 1;
const place = (facts, budgets = [], devices = []) => placeFor({ job: 'make-a-preview', facts, matches, budgets, devices }).then(answer => answer.id);

test('a preview is made where the person pays nothing, and on Trillion only inside a budget they set', async () => {
  assert.equal(await place({ made_at_capture: true, viewer_can: true }), 'capturing-device');
  const mac = { placement: 'placement:your-computer', tool_id: 'tool:a-preview-tool', agent_id: 'computer-tools' };
  assert.equal(await place({ viewer_can: true }, [], [mac]), 'awake-device');
  assert.equal(await place({ devices_awake_that_can: 2, viewer_can: true }), 'viewing-device', 'a device place needs a device to hand the work to');
  assert.equal(await place({ viewer_can: true }), 'viewing-device', 'with nothing awake, the device they open it on makes it');
  assert.equal(await place({}), 'wait', 'with no device and no budget it waits, never on Trillion');
  assert.equal(await place({}, [{ id: 'trillion-work-day', most_dollars: 0.5 }]), 'trillion');
  assert.equal(await place({ viewer_can: true }, [{ id: 'trillion-work-day', most_dollars: 0.5 }]), 'viewing-device', 'a budget is used only when no device of theirs can');
  assert.equal(trillionBudgetDollars([{ id: 'other', most_dollars: 9 }]), 0);
  await assert.rejects(placeFor({ job: 'no-such-job', matches }), /No job no-such-job/);
});

test('a recording is heard by an awake device that keeps the hearing tool, else on Trillion only inside a budget, else it waits', async () => {
  const now = new Date('2026-10-05T20:00:00Z');
  const card = skills => () => ({ takes_work: true, skills, capacity_claim: { max_concurrent: 4, expires_at: '2026-10-05T21:00:00Z' } });
  const keeps = [{ id: 'tool:hear-a-recording', name: 'tool:hear-a-recording' }];
  const awake = devicesAwake({ job: 'hear-a-recording', card: card(keeps), now });
  assert.deepEqual(awake, [{ placement: 'placement:your-computer', tool_id: 'tool:hear-a-recording', agent_id: 'computer-tools' }]);
  assert.deepEqual(devicesAwake({ job: 'hear-a-recording', card: card([{ name: 'tool:listen' }]), now }), [], 'a Mac on older code that lacks the tool is not counted');
  assert.deepEqual(devicesAwake({ job: 'hear-a-recording', card: card(keeps), now: new Date('2026-10-05T22:00:00Z') }), [], 'a claim that ran out means the Mac is asleep');
  assert.deepEqual(devicesAwake({ job: 'hear-a-recording', card: () => null, now }), []);
  const hear = (devices, budgets = []) => placeFor({ job: 'hear-a-recording', matches, budgets, devices });
  const there = await hear(awake);
  assert.equal(there.id, 'awake-device');
  assert.equal(there.pays, 'person');
  assert.equal(there.device.tool_id, 'tool:hear-a-recording');
  assert.equal((await hear([])).id, 'wait', 'no awake device and no budget: it waits, never on Trillion');
  assert.equal((await hear([], [{ id: 'trillion-work-day', most_dollars: 1 }])).pays, 'trillion');
  assert.equal((await hear(awake, [{ id: 'trillion-work-day', most_dollars: 1 }])).id, 'awake-device', 'the device first, even with a budget');
});
