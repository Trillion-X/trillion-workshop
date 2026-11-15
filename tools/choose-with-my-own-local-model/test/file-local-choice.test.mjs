import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseFilePursuit, filePursuitOptions } from '../read-data/file-local-choice.mjs';

const organization = { status: 'grounded', title: 'Calendar week view', category: 'Image', tags: ['calendar', 'week'] };
const pursuits = [
  { id: 'pursuit:calendar', title: 'Build a calendar', now: 'Working on week views', status: 'active' },
  { id: 'pursuit:music', title: 'Make music', status: 'active' },
  { id: 'pursuit:old', title: 'Old calendar', status: 'ended' },
];

test('file choice maps only recorded active pursuits and allows no supported link', async () => {
  const options = filePursuitOptions(organization, pursuits);
  assert.equal(options.mapping.get('p1'), 'pursuit:calendar');
  assert.equal(options.candidates.at(-1).id, 'none');
  assert.ok(![...options.mapping.values()].includes('pursuit:old'));
  const inputs = [];
  const linked = await chooseFilePursuit({ organization, pursuits,
    ask: async input => { inputs.push(input); return { model: 'your-ais:Codex', reply: '{"id":"p1","reason":"Direct match"}' }; } });
  assert.equal(linked.pursuit, 'pursuit:calendar');
  assert.equal(linked.model, 'your-ais:Codex');
  assert.equal(inputs[0].messages[0].role, 'system');
  assert.ok(!('tool_id' in inputs[0]), 'background work supplies model input, not a device-owned tool request');
  const none = await chooseFilePursuit({ organization, pursuits,
    ask: async () => ({ model: 'your-ais:Claude', reply: '{"id":"none","reason":"Weak evidence"}' }) });
  assert.equal(none.pursuit, null);
  assert.equal((await chooseFilePursuit({ organization: { ...organization, status: 'awaiting-evidence' }, pursuits })).skipped,
    'The file has no extracted description yet.');
});
