// The person's hooks and typed refusal reasons in the Mac screen driver's decision table (read-data/run-decision.mjs invariants 6-7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decisionSettings, requireAllowed, requireHooks } from '../read-data/run-decision.mjs';

const settings = decisionSettings();
const homeWith = rules => {
  const home = mkdtempSync(join(tmpdir(), 'hooks-'));
  const file = join(home, settings.rules_file);
  mkdirSync(join(file, '..'), { recursive: true });
  if (rules) { writeFileSync(file, JSON.stringify(rules)); chmodSync(file, 0o600); }
  return home;
};
const node = code => ({ command: [process.execPath, '-e', code] });
const subject = { action: 'press', app: ['Probe'] };

test('no hooks listed runs nothing; an allowing hook lets the action through and gets the subject on stdin', async () => {
  await requireHooks(settings, homeWith(null), subject);
  const home = homeWith({ hooks: [node("let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const x=JSON.parse(s);console.log(JSON.stringify({decision:x.action==='press'?'allow':'deny'}))})")] });
  await requireHooks(settings, home, subject);
});

test('a denying hook refuses with its reason and the stable code; a hook that fails, times out or answers nonsense is refused too (fail closed)', async () => {
  const deny = homeWith({ hooks: [node("console.log(JSON.stringify({decision:'deny',reason:'banking app'}))")] });
  await assert.rejects(requireHooks(settings, deny, subject), error => { assert.equal(error.reason, 'hook-denied'); assert.match(error.message, /banking app/); return true; });
  for (const code of ['process.exit(3)', 'console.log("not json")', "console.log(JSON.stringify({decision:'maybe'}))"]) {
    await assert.rejects(requireHooks(settings, homeWith({ hooks: [node(code)] }), subject), error => error.reason === 'hook-failed');
  }
  await assert.rejects(requireHooks(settings, homeWith({ hooks: [{ ...node('setTimeout(()=>{},9000)'), timeout_ms: 150 }] }), subject), error => { assert.equal(error.reason, 'hook-failed'); assert.match(error.message, /no answer in 150 ms/); return true; });
  await assert.rejects(requireHooks(settings, homeWith({ hooks: [{ command: ['/no/such/program'] }] }), subject), error => error.reason === 'hook-failed');
});

test('on_failure allow lets a hook that cannot answer through, and list refusals carry codes', async () => {
  const open = { ...settings, hooks: { ...settings.hooks, on_failure: 'allow' } };
  await requireHooks(open, homeWith({ hooks: [node('process.exit(3)')] }), subject);
  assert.throws(() => requireAllowed(settings, homeWith({ user_deny: [{ app: 'Probe' }] }), subject), error => error.reason === 'denied-by-list');
  assert.throws(() => requireAllowed(settings, homeWith({ strict: true }), subject), error => error.reason === 'strict-not-allowed');
});
