// tools/workflows/test/fires-when-by-source.test.mjs
// A workflow whose fires_when says a fact's source equals X is chosen for source X, not for Y, for no source at all, or for
// a source that differs only in case; two facts choose only the X one; extra fields do not stop it. This is the port of the
// old listen_for_events filter: the fact's source is a condition, so no table or filter is added. The field shape is the one
// the live "Act on feedback" workflow uses (workflow_recipes, a choice field with is_any_of).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseTheWorkflowsThatFire } from '../read-data/choose-the-workflows-that-fire.mjs';

const condition = {
  fields: [{ id: 'source', kind: 'choice', path: ['source'] }],
  tree: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'source', operator: 'is_any_of', params: { values: ['X'] } }] },
};
const own = [{ id: 'source-x-proof', value: { title: 'Source X proof', fires_when: [{ label: 'source is X', condition, made_by: 'fires_when', state: 'On' }] } }];
const chosen = async parts => (await chooseTheWorkflowsThatFire({ parts, own, installed: false })).chosen.map(c => ({ workflow: c.workflow, part: c.part }));

test('a fact whose source is X is chosen', async () => {
  assert.deepEqual(await chosen([{ source: 'X' }]), [{ workflow: 'workflow:source-x-proof', part: 0 }]);
});

test('a fact from another source is not chosen', async () => {
  assert.deepEqual(await chosen([{ source: 'Y' }]), []);
});

test('a fact with no source field is not chosen', async () => {
  assert.deepEqual(await chosen([{ other: 1 }]), []);
});

test('a source that differs only in case is not chosen (the match is exact)', async () => {
  assert.deepEqual(await chosen([{ source: 'x' }]), []);
});

test('two facts in one change choose only the X one, by its position', async () => {
  assert.deepEqual(await chosen([{ source: 'X' }, { source: 'Y' }]), [{ workflow: 'workflow:source-x-proof', part: 0 }]);
});

test('extra fields on an X fact do not stop it being chosen', async () => {
  assert.deepEqual(await chosen([{ source: 'X', kind: 'message', n: 3 }]), [{ workflow: 'workflow:source-x-proof', part: 0 }]);
});
