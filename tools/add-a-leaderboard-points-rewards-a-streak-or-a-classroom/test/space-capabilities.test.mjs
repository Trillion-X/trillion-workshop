import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesOf, switchCapability } from '../src/space-capabilities.mjs';

test('a space can add a leaderboard and keep its settings when switched off and on', () => {
  const original = { title: 'Riverside Studio', spaces: { members: 'members' } };
  const withBoard = switchCapability(original, 'leaderboard', true);
  assert.equal(capabilitiesOf(withBoard).find(row => row.id === 'points').on, true);
  assert.equal(capabilitiesOf(withBoard).find(row => row.id === 'leaderboard').on, true);
  assert.equal(original.spaces.leaderboard, undefined, 'the input is unchanged');

  withBoard.levels.bands.push({ name: 'Riverside expert', min: 100 });
  const hidden = switchCapability(withBoard, 'points', false);
  assert.equal(capabilitiesOf(hidden).find(row => row.id === 'leaderboard').on, false, 'a dependent part is off too');
  assert.equal(hidden.set_aside.points.levels.bands.at(-1).name, 'Riverside expert');

  const restored = switchCapability(hidden, 'leaderboard', true);
  assert.equal(capabilitiesOf(restored).find(row => row.id === 'leaderboard').on, true);
  assert.equal(restored.levels.bands.at(-1).name, 'Riverside expert');
});
