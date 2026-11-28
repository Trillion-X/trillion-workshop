// workflow:keep-tool-copies-in-step is chosen by tool:choose-the-workflows-that-fire for a push on a repository's main branch
// (the part the route workflow makes of a GitHub push fact: where, place = the pushed ref, change = changed), and not for a
// push on another branch, a part with no source, or a change that is not a push's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseTheWorkflowsThatFire } from '../read-data/choose-the-workflows-that-fire.mjs';

const ID = 'workflow:keep-tool-copies-in-step';
const push = (extra = {}) => ({ where: 'github:my-registry-of-tools', place: 'refs/heads/main', change: 'changed',
  key: '9f2c6d5e4b3a29180716f5e4d3c2b1a0f9e8d7c6', after: 'example-owner/my-registry-of-tools', ...extra });
const chosen = async parts => (await chooseTheWorkflowsThatFire({ explain: true, parts, own: [] })).chosen.filter(item => item.workflow === ID);

test('a push on main chooses the sync with its condition', async () => {
  assert.deepEqual((await chosen([push()])).map(({ part, condition, from }) => ({ part, condition, from })),
    [{ part: 0, condition: 'a tool source or a project was pushed on its main branch', from: 'catalog' }]);
});

test('a push on another branch, a part with no source, or another kind of change is not chosen', async () => {
  assert.deepEqual(await chosen([push({ place: 'refs/heads/x' })]), []);
  assert.deepEqual(await chosen([push({ place: 'refs/tags/v1' })]), []);
  assert.deepEqual(await chosen([push({ where: '' })]), []);
  assert.deepEqual(await chosen([push({ change: 'removed' })]), []);
});

test('of several parts only the main pushes are chosen', async () => {
  assert.deepEqual((await chosen([push({ place: 'refs/heads/x' }), push(), push({ where: 'github:another-project' })])).map(item => item.part), [1, 2]);
});
