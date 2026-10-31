// Options that may go ahead together. Carried from the original package's configuration gauntlet (seven cases), on a
// made-up bakery; its scope fields are given with each request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectConfigurations } from '../read-data/select-configurations.mjs';

const SCOPE_FIELDS = ['goal_ref', 'team_ref', 'horizon_ref', 'stage_ref'];
const scope = goal => ({ goal_ref: goal, team_ref: `team:${goal}`, horizon_ref: 'horizon:this-week', stage_ref: 'stage:current' });
const configuration = (id, kind, expectedValue, goal, extra = {}) => ({ id, configuration_kind: kind, expected_value: expectedValue, scope: scope(goal), required_resource_refs: [], collision_refs: [], ...extra });
const select = configurations => selectConfigurations({ configurations, scope_fields: SCOPE_FIELDS });
const selectedIds = result => result.selected.map(entry => entry.id).sort();

test('a higher-value workflow beats a person who needs the same one hour', () => {
  const result = select([
    configuration('person-match', 'human-group', 0.3, 'goal:stall', { collision_refs: ['resource:one-hour-of-the-owner'] }),
    configuration('workflow', 'workflow', 0.95, 'goal:stall', { collision_refs: ['resource:one-hour-of-the-owner'] }),
  ]);
  assert.deepEqual(selectedIds(result), ['workflow']);
  assert.deepEqual(result.rejected, [{ id: 'person-match', reason: 'resource_collision', collision_ref: 'resource:one-hour-of-the-owner' }]);
});

test('software, record changes, triggers, formulas, tools, places and resources need no person', () => {
  const kinds = ['software-package', 'record-change', 'workflow', 'trigger-rule', 'formula', 'tool', 'place', 'resource'];
  const configurations = kinds.map((kind, index) => configuration(`config:${kind}`, kind, 0.9 - index / 100, `goal:${kind}`));
  const result = select(configurations);
  assert.deepEqual(selectedIds(result), configurations.map(entry => entry.id).sort());
  assert.ok(result.selected.every(entry => entry.configuration_kind !== 'human-group'));
});

test('no person is chosen when a tool is worth more, and nothing is chosen at zero', () => {
  const stronger = select([
    configuration('person', 'human-group', 0.2, 'goal:sourdough', { collision_refs: ['resource:oven-hour'] }),
    configuration('proofing-camera', 'software-package', 0.8, 'goal:sourdough', { collision_refs: ['resource:oven-hour'] }),
  ]);
  assert.deepEqual(selectedIds(stronger), ['proofing-camera']);
  assert.deepEqual(selectedIds(select([configuration('unsupported-person', 'human-group', 0, 'goal:sourdough')])), []);
});

test('a configuration missing any scope field is not chosen', () => {
  for (const missing of SCOPE_FIELDS) {
    const invalid = configuration(`missing:${missing}`, 'tool', 1, 'goal:scope-test');
    delete invalid.scope[missing];
    const result = select([invalid]);
    assert.deepEqual(selectedIds(result), []);
    assert.equal(result.rejected[0].reason, 'scope_missing');
  }
});

test('the best option for one goal never holds back work for another goal', () => {
  const result = select([
    configuration('sourdough:analyze', 'software-package', 0.95, 'goal:sourdough'),
    configuration('stall:test-prices', 'workflow', 0.99, 'goal:stall'),
    configuration('supplier:prepare-call', 'prepared-human-action', 0.7, 'goal:supplier'),
  ]);
  assert.deepEqual(selectedIds(result), ['sourdough:analyze', 'stall:test-prices', 'supplier:prepare-call']);
});

test('options for one goal that do not compete all go ahead', () => {
  const result = select([
    configuration('crust:test-temperature', 'human-action', 0.99, 'goal:sourdough'),
    configuration('crust:sort-photos', 'workflow', 0.7, 'goal:sourdough'),
    configuration('crust:prepare-analysis', 'software-package', 0.8, 'goal:sourdough'),
  ]);
  assert.deepEqual(selectedIds(result), ['crust:prepare-analysis', 'crust:sort-photos', 'crust:test-temperature']);
});

test('a kind never seen before is only a word', () => {
  const unseen = '\u{1F4A5}/future-capability::not-a-person<script>';
  const result = select([configuration('unseen', unseen, 0.9, 'goal:future')]);
  assert.deepEqual(selectedIds(result), ['unseen']);
  assert.equal(result.selected[0].configuration_kind, unseen);
});

test('two that compete within the distinguishable delta are both held back, and scope fields are required', () => {
  const result = selectConfigurations({
    scope_fields: SCOPE_FIELDS, minimum_distinguishable_delta: 0.05,
    configurations: [
      configuration('a', 'tool', 0.50, 'goal:stall', { collision_refs: ['resource:table'] }),
      configuration('b', 'tool', 0.52, 'goal:stall', { collision_refs: ['resource:table'] }),
      configuration('c', 'tool', 0.40, 'goal:stall'),
    ],
  });
  assert.deepEqual(selectedIds(result), ['c']);
  assert.deepEqual(result.rejected.map(entry => [entry.id, entry.reason]), [['a', 'indistinguishable_expected_value'], ['b', 'indistinguishable_expected_value']]);
  assert.throws(() => selectConfigurations({ configurations: [] }), /scope_fields/);
});
