// parts/work-map/read-data/join-records.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { branchOf, joinRecords, valueAt } from '../../../read-data/join-records.mjs';

const data = JSON.parse(readFileSync(new URL(import.meta.resolve('trillion-workshop/tools/see-what-is-being-worked-on/read-data/work-map-sources.json')), 'utf8'));
const answers = {
  goals: {
    pursuits: [
      { id: 'p-grow', title: 'Grow the academy', parents: [] },
      { id: 'p-site', title: 'New website', parents: ['p-grow'] },
    ],
    summaries: [{ case_id: 'c1', goal: 'Which page first', status: 'needs_outcome', pursuits: [{ id: 'p-site', title: 'New website' }] }],
  },
  work: {
    agents: [{ agent_id: 'a1', name: 'Builder', model: 'opus', capacity: { status: 'full' } }],
    work: [
      { handoff_id: 'h1', job: 'Build the page', status: 'taken', case_id: 'c1', taken_by: 'a1' },
      { handoff_id: 'h2', job: 'Write the copy', status: 'finished', parent_handoff_id: 'h1', taken_by: 'a1' },
      { handoff_id: 'h3', job: 'Loose job', status: 'waiting', to_agent: 'a1' },
      { handoff_id: 'h4', job: 'Nobody yet', status: 'waiting' },
    ],
  },
  spaces: { spaces: [
    { space_id: 's1', title: 'Coaches', member_names: ['Dana', 'Morgan'] },
    { space_id: 's2', title: 'Sales', member_names: ['Dana'] },
  ] },
  automations: { automations: [
    { id: 'weekly-video', open_id: 'automation:weekly-video', name: 'Weekly video review', does: 'Review the new video', enabled: true, next_run_at: '2026-10-07T09:00:00Z' },
    { id: 'old-reminder', open_id: 'automation:old-reminder', name: 'Old reminder', does: 'Send a reminder', enabled: false, next_run_at: null },
    { id: 'weekly-review', open_id: 'weekly-review', kind: 'workflow', name: 'Weekly review', does: 'Review weekly', enabled: null, next_run_at: null },
  ] },
  workshop: { runs: [
    { id: 'run-1', title: 'Review the landing page', job: 'Check the newest page', state: 'Working', started_at: '2026-10-06T08:00:00Z' },
  ] },
};

test('every kind hangs where its rows say, and only real rows become nodes', () => {
  const { nodes, lines } = joinRecords({ root: data.root, sources: data.sources, answers });
  const has = (from, to) => lines.some(line => line.from === from && line.to === to);
  assert.ok(has('root', 'goal:p-grow'));
  assert.ok(has('goal:p-grow', 'goal:p-site'));
  assert.ok(has('goal:p-site', 'decision:c1'));
  assert.ok(has('decision:c1', 'job:h1'));
  assert.ok(has('job:h1', 'job:h2'), 'a part hangs under the job it is part of, not the decision');
  assert.ok(has('ai:a1', 'job:h3'), 'a job under no goal hangs under the AI asked to do it');
  assert.ok(has('root', 'job:h4'), 'a job nobody does yet hangs from the root');
  assert.ok(has('space:s1', 'person:Dana') && has('space:s2', 'person:Dana'), 'one person, a line from each space');
  assert.equal(nodes.filter(node => node.id === 'person:Dana').length, 1);
  assert.equal(nodes.find(node => node.id === 'job:h1').who, 'ai:a1');
  assert.equal(nodes.find(node => node.id === 'ai:a1').status, 'full');
  assert.equal(nodes.find(node => node.id === 'automation:weekly-video').status, 'on');
  assert.equal(nodes.find(node => node.id === 'automation:old-reminder').status, 'off');
  assert.equal(nodes.find(node => node.id === 'automation:weekly-review').status, 'ready');
  assert.equal(nodes.find(node => node.id === 'automation:weekly-video').at, '2026-10-07T09:00:00Z');
  assert.equal(nodes.find(node => node.id === 'tool-run:run-1').title, 'Review the landing page');
  assert.ok(has('root', 'automation:weekly-video'));
  assert.ok(has('root', 'tool-run:run-1'));
  assert.ok(lines.every(line => nodes.some(node => node.id === line.from) && nodes.some(node => node.id === line.to)));
});

test('a source with no answer adds nothing, and a parent not shown falls through', () => {
  const { nodes, lines } = joinRecords({ root: data.root, sources: data.sources, answers: { work: { agents: [], work: [{ handoff_id: 'x', job: 'Orphan', status: 'open', parent_handoff_id: 'gone', case_id: 'gone' }] } } });
  assert.deepEqual(nodes.map(node => node.id).sort(), ['job:x', 'root']);
  assert.deepEqual(lines.map(line => [line.from, line.to]), [['root', 'job:x']]);
});

test('paths read plain keys, lists and every item', () => {
  assert.deepEqual(valueAt({ a: [{ b: 1 }, { b: 2 }] }, ['a', '*', 'b']), [1, 2]);
  assert.deepEqual(valueAt({ a: ['x', 'y'] }, ['a']), ['x', 'y']);
  assert.deepEqual(valueAt({ a: null }, ['a', 'b']), []);
});

test('starting from one goal keeps that goal and everything under it, and nothing beside it', () => {
  const tree = joinRecords({ root: data.root, sources: data.sources, answers });
  const branch = branchOf(tree, 'goal:p-site');
  const ids = branch.nodes.map(node => node.id);
  assert.ok(ids.includes('goal:p-site') && ids.includes('decision:c1'));
  assert.ok(!ids.includes('goal:p-grow') && !ids.includes('root'));
  assert.ok(branch.lines.every(line => ids.includes(line.from) && ids.includes(line.to)));
  assert.deepEqual(branchOf(tree, 'goal:nothing'), tree);
});
