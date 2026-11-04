// An opt-in private mode: unknown features are off in it, everything is on without it, one sentence per feature, a comparable security code (read-data/private-mode.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { available, explain, securityCode } from '../read-data/private-mode.mjs';

test('off means everything is available; on keeps only what the table says and anything unlisted is off', () => {
  assert.equal(available({ on: false }, 'sound'), true);
  assert.equal(available(undefined, 'summaries'), true);
  assert.equal(available({ on: true }, 'captions'), true);
  assert.equal(available({ on: true }, 'sound'), false);
  assert.equal(available({ on: true }, 'a-feature-added-later'), false);
  const said = explain({ on: true });
  assert.equal(said.find(row => row.feature === 'summaries').says, 'meeting apps are not available in private mode.'.replace('meeting apps', 'summaries by a service'));
  console.log('REAL readback:', JSON.stringify(said.map(row => `${row.feature}:${row.available}`)));
});

test('the security code is the same for the same keys in any order and changes with one key', () => {
  const code = securityCode(['key-b', 'key-a']);
  assert.match(code, /^(\d{5} ){5}\d{5}$/);
  assert.equal(securityCode(['key-a', 'key-b']), code);
  assert.notEqual(securityCode(['key-a', 'key-c']), code);
});
