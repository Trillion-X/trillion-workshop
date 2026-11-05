// A hook row may name a step: before_tool_run can refuse a tool this Mac was handed, after_tool_run is told how it ended,
// and a row is run only at its own step (computer/run-decision.mjs requireHooks, computer/mac-tools.mjs runHere).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decisionSettings, requireHooks } from '../run-decision.mjs';

const settings = decisionSettings();
function home(hooks) {
  const dir = mkdtempSync(join(tmpdir(), 'hook-steps-'));
  const file = join(dir, settings.rules_file);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ hooks }));
  chmodSync(file, 0o600);
  return { dir, log: join(dir, 'told.log') };
}
const script = (dir, name, body) => { const path = join(dir, name); writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); return path; };

test('a before_tool_run hook can refuse a named tool, a matcher narrows it, and other steps are not asked', async () => {
  const { dir } = home([]);
  const deny = script(dir, 'deny.sh', 'cat >/dev/null; echo \'{"decision":"deny","reason":"not this one"}\'');
  const file = join(dir, settings.rules_file);
  writeFileSync(file, JSON.stringify({ hooks: [{ step: 'before_tool_run', matcher: 'tool:print*', command: [deny] }] }));
  chmodSync(file, 0o600);
  await assert.rejects(requireHooks(settings, dir, { step: 'before_tool_run', action: 'tool:print' }), error => error.status === 403 && /not this one/.test(error.message));
  await requireHooks(settings, dir, { step: 'before_tool_run', action: 'tool:listen' });
  await requireHooks(settings, dir, { action: 'press', app: ['Safari'] });
});

test('an after_tool_run hook is told how the run ended and can never refuse it', async () => {
  const { dir, log } = home([]);
  const tell = script(dir, 'tell.sh', `cat >> ${log}; echo >> ${log}; echo 'garbage'`);
  const file = join(dir, settings.rules_file);
  writeFileSync(file, JSON.stringify({ hooks: [{ step: 'after_tool_run', command: [tell] }] }));
  chmodSync(file, 0o600);
  await requireHooks(settings, dir, { step: 'after_tool_run', action: 'tool:print', ok: true });
  assert.ok(existsSync(log));
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8').trim()), { step: 'after_tool_run', action: 'tool:print', ok: true });
});
