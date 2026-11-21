// The account address the helper takes from its start command (harness/wake-sessions.mjs originFlag): `--origin ADDRESS`
// is what the computer's unit names, so the helper talks to that address and no environment variable is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { originFlag } from '../harness/wake-sessions.mjs';

test('the origin is the value after --origin, with a trailing slash dropped', () => {
  assert.equal(originFlag(['node', 'wake-sessions.mjs', '--origin', 'https://app.example.test/']), 'https://app.example.test');
  assert.equal(originFlag(['node', 'wake-sessions.mjs', '--key-credential', 'account-key', '--origin', 'https://app.example.test']), 'https://app.example.test');
});

test('no --origin, or one with no value, leaves the origin to the settings', () => {
  assert.equal(originFlag(['node', 'wake-sessions.mjs', '--key-credential', 'account-key']), null);
  assert.equal(originFlag(['node', 'wake-sessions.mjs', '--origin']), null);
  assert.equal(originFlag(['node', 'wake-sessions.mjs', '--origin', '']), null);
});
