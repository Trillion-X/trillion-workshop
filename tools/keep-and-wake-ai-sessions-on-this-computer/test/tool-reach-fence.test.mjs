// test/tool-reach-fence.test.mjs
//
// The two extra layers around a Marketplace tool run on this Mac (harness/wake-handlers/tool-reach.mjs, from the Dia
// findings F-0447, F-0448, F-0600, F-0601): a kernel rule that starts only the programs the run's rows allow, a
// description of the run built from those same rows, and argument rules checked before the command starts. Both are
// off by default (exec.mode "open", every argument rule disabled).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import settings from '../harness/wake-handlers/tool-reach.json' with { type: 'json' };
import { argumentRefusal, declaredReach, describeRun, sandboxProfile, sandboxed } from '../harness/wake-handlers/tool-reach.mjs';

const onMac = process.platform === 'darwin';
const allowlist = { ...structuredClone(settings), exec: { mode: 'allowlist', allow: [{ path: '/bin/echo', match: 'literal' }] } };
const home = mkdtempSync('/tmp/fence-home-');
const running = argv => new Promise(done => execFile(argv[0], argv.slice(1), (error, stdout, stderr) => done({ code: error ? (error.code ?? 1) : 0, stdout, stderr })));

test('shipped data is open: no exec limit and every argument rule off', () => {
  assert.equal(settings.exec.mode, 'open');
  assert.ok(settings.argument_rules.length >= 2 && settings.argument_rules.every(row => row.enabled === false));
  assert.equal(argumentRefusal(['find', '.', '-exec', 'rm', '{}', ';']), null);
  assert.equal(describeRun().programs, 'any program');
  assert.doesNotMatch(sandboxProfile({ folder: home, reach: [], home }), /process-exec/);
});

test('an enabled rule refuses find -exec and an agent type outside its list, in its own words, and nothing else', () => {
  const on = { ...structuredClone(settings), argument_rules: settings.argument_rules.map(row => ({ ...row, enabled: true, ...(row.only_values ? { only_values: ['writer'] } : {}) })) };
  assert.match(argumentRefusal(['/usr/bin/find', '.', '-name', 'x', '-exec', 'rm', '{}', ';'], { rules: on }), /find with -exec/);
  assert.match(argumentRefusal(['find', '.', '-execdir', 'sh', ';'], { rules: on }), /find with -exec/);
  assert.equal(argumentRefusal(['find', '.', '-name', 'exec'], { rules: on }), null, 'a file called exec is not the flag');
  assert.equal(argumentRefusal(['tool', '--agent-type', 'writer'], { rules: on }), null);
  assert.match(argumentRefusal(['tool', '--agent-type', 'shell'], { rules: on }), /may not start an agent/);
  assert.match(argumentRefusal(['tool', '--agent-type=shell'], { rules: on }), /may not start an agent/);
  const none = { ...on, argument_rules: on.argument_rules.map(row => (row.only_values ? { ...row, only_values: [] } : row)) };
  assert.match(argumentRefusal(['tool', '--agent-type', 'writer'], { rules: none }), /may not start an agent/, 'an empty list refuses any value');
  assert.equal(argumentRefusal(['tool', 'plain'], { rules: on }), null);
});

test('the description of a run is built from the same rows that build the fence', () => {
  const said = describeRun({ rules: allowlist, reach: declaredReach({ reach: [{ kind: 'network', port: 443 }] }, { home }) });
  assert.deepEqual(said.programs, ['its own files', 'its interpreter', '/usr/bin/env', '/bin/echo']);
  assert.deepEqual(said.reach, ['reach the internet on port 443']);
  const profile = sandboxProfile({ folder: home, reach: [], home, rules: allowlist, program: '/bin/ls' });
  assert.match(profile, /\(deny process-exec\*\)/);
  assert.match(profile, /\(literal "\/bin\/echo"\)/);
  // The program is named by its real path: /bin/ls on a Mac, /usr/bin/ls where /bin is a link to /usr/bin.
  assert.ok(profile.includes(`(literal "${realpathSync('/bin/ls')}")`), profile);
});

test('the kernel starts the allowed program and refuses another', { skip: !onMac }, async () => {
  const folder = mkdtempSync('/tmp/fence-run-');
  const profile = sandboxProfile({ folder, reach: [], home, rules: allowlist, program: '/bin/echo' });
  const allowed = await running(sandboxed(['/bin/echo', 'hello'], { folder, profile }));
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), 'hello');
  const refused = await running(sandboxed(['/bin/ls', folder], { folder, profile: sandboxProfile({ folder, reach: [], home, rules: allowlist, program: '/bin/ls' }).replace('(literal "/bin/ls")', '') }));
  assert.notEqual(refused.code, 0, 'ls was not allowed to start');
  const inFolder = join(folder, 'own.sh');
  writeFileSync(inFolder, '#!/bin/sh\necho own\n');
  chmodSync(inFolder, 0o755);
  const own = await running(sandboxed(['/bin/sh', inFolder], { folder, profile: sandboxProfile({ folder, reach: [], home, rules: { ...allowlist, exec: { mode: 'allowlist', allow: [{ path: '/bin/sh', match: 'literal' }, { path: '/bin/bash', match: 'literal' }] } }, program: '/bin/sh' }) }));
  assert.equal(own.stdout.trim(), 'own', own.stderr);
});
