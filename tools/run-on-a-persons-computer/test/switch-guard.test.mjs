// The app's programs refuse debugger and TLS-weakening switches unless a support token matches (computer/switch-guard.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { endWithTheApp } from '../end-with-the-app.mjs';
import { checkSwitches, guardSettings } from '../switch-guard.mjs';

const settings = guardSettings();
const child = extra => ({ [settings.app_child_variable]: '1', ...extra });

test('a dangerous switch or variable is refused in a program the app started, and ignored in a developer\'s own run', () => {
  assert.deepEqual(checkSwitches({ execArgv: [], env: child({}), settings }), { ok: true, applies: true });
  const inspect = checkSwitches({ execArgv: ['--inspect=9229'], env: child({}), settings });
  assert.equal(inspect.ok, false);
  assert.match(inspect.said, /--inspect/);
  assert.equal(checkSwitches({ execArgv: [], env: child({ NODE_OPTIONS: '--require /tmp/x.js' }), settings }).ok, false, 'a preloaded module through NODE_OPTIONS is refused');
  assert.equal(checkSwitches({ execArgv: [], env: child({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }), settings }).found[0].what, 'NODE_TLS_REJECT_UNAUTHORIZED');
  assert.equal(checkSwitches({ execArgv: [], env: child({ NODE_TLS_REJECT_UNAUTHORIZED: '1' }), settings }).ok, true);
  assert.deepEqual(checkSwitches({ execArgv: ['--inspect'], env: {}, settings }), { ok: true, applies: false });
});

test('a support token whose BLAKE3 is shipped allows the run and is never logged; a wrong one does not', () => {
  const token = 'one-time-support-token';
  const shipped = { ...settings, support_token_blake3: [makeHashCodeHexFromBytes(new TextEncoder().encode(token)).slice(3)] };
  const lines = [];
  const allowed = checkSwitches({ execArgv: ['--inspect'], env: child({ [settings.token_variable]: token }), settings: shipped, log: line => lines.push(line) });
  assert.equal(allowed.overridden, true);
  assert.ok(lines.length === 1 && !lines[0].includes(token));
  assert.equal(checkSwitches({ execArgv: ['--inspect'], env: child({ [settings.token_variable]: 'guess' }), settings: shipped }).ok, false);
});

test('endWithTheApp refuses to start a program that carries a dangerous switch', () => {
  let refused = 0;
  endWithTheApp({ parentOf: () => 1, guard: () => checkSwitches({ execArgv: ['--inspect'], env: child({}), settings }), refuse: () => { refused += 1; } });
  endWithTheApp({ parentOf: () => 1, guard: () => checkSwitches({ execArgv: [], env: child({}), settings }), refuse: () => { refused += 1; } });
  assert.equal(refused, 1);
});
