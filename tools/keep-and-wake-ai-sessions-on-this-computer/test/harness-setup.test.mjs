import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandWords, configPath, desiredHooks, hookEvidence, hostFor, inspectCodex, localRuntimeChecks, mergeHooks, runConfiguredHook, settings, setup, verifyPayload, writeConfig } from '../harness/setup.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SELF = join(ROOT, 'harness', 'setup.mjs');
const okay = { status: 0, stdout: '', stderr: '' };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'trillion-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "account's $work");
  const payload = join(root, 'checkout', 'harness');
  mkdirSync(home, { recursive: true }); mkdirSync(payload, { recursive: true });
  for (const file of settings.payload.required) writeFileSync(join(payload, file), file.endsWith('.mjs') ? 'export const loaded = true;\n' : '{}\n');
  writeFileSync(join(payload, 'wake-sessions.json'), JSON.stringify({ folder: '~/.trillion/wake-sessions', settings_file: 'settings.json', keychain_item: 'fixture-account-key' }));
  writeFileSync(join(payload, 'take-open-work.json'), JSON.stringify({ ais: [{ id: 'chosen-by-person', command: ['fixture-ai'] }] }));
  const options = { home, payload, platform: 'darwin', env: {}, harness: 'claude-code', installer: SELF,
    inspectPayload: () => ({ id: 'payload', status: 'ready', path: payload, runtime: process.execPath }),
    execute: (command, args) => { assert.equal(command, 'claude'); assert.deepEqual(args, ['--version']); return { ...okay, stdout: 'fixture CLI' }; },
    inspectRuntime: () => [{ id: 'runtime', status: 'ready', evidence: { test_fixture: true } }],
  };
  return { root, home, payload, options, path: configPath(hostFor('claude-code'), options) };
}

test('apply preserves unrelated config, repeats without churn, and removes after the payload is gone', async t => {
  const f = fixture(t);
  const original = { permissions: { allow: ['Read'], deny: ['Bash(rm:*)'] }, model: 'person-picked', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep-my-hook', timeout: 3 }] }] } };
  mkdirSync(dirname(f.path), { recursive: true }); writeFileSync(f.path, JSON.stringify(original));
  const first = await setup({ ...f.options, action: 'apply' });
  assert.equal(first.checks.find(row => row.id === 'configuration').status, 'ready');
  for (const hook of first.checks.find(row => row.id === 'configuration').evidence.hooks) {
    assert.match(hook.definition_hash, /^[a-f0-9]{64}$/);
    assert.equal(first.checks.find(row => row.id === `ran-${hook.id}`).evidence.definition_hash, hook.definition_hash);
  }
  assert.equal(first.ready, false, 'a config file does not prove hooks have actually run');
  assert.deepEqual(first.checks.filter(row => row.id.startsWith('ran-') && row.status === 'pending').map(row => row.id).sort(), settings.hooks.map(hook => `ran-${hook.id}`).sort());
  assert.equal(first.changes[0].changed, true);
  assert.equal(readFileSync(first.changes[0].backup, 'utf8'), JSON.stringify(original));
  const installedText = readFileSync(f.path, 'utf8'); const installed = JSON.parse(installedText);
  assert.deepEqual(installed.permissions, original.permissions); assert.equal(installed.model, original.model);
  const installedHooks = Object.values(installed.hooks).flatMap(groups => groups.flatMap(group => group.hooks));
  assert.equal(installedHooks.length, settings.hooks.length + 1);
  assert.deepEqual(installedHooks.filter(hook => hook.command.includes('--run-hook')).map(hook => commandWords(hook.command)[3]).sort(), settings.hooks.map(hook => hook.id).sort());
  assert.deepEqual(installed.hooks.Stop[0], original.hooks.Stop[0]);
  const second = await setup({ ...f.options, action: 'apply' });
  assert.equal(second.changes[0].changed, false); assert.equal(readFileSync(f.path, 'utf8'), installedText);
  assert.equal(readdirSync(dirname(f.path)).filter(name => name.includes('backup')).length, 1);
  rmSync(f.payload, { recursive: true });
  const removed = await setup({ ...f.options, platform: 'linux', action: 'remove', inspectPayload: () => { throw new Error('removal must not execute missing payload'); }, execute: () => { throw new Error('removal must not start a host'); } });
  assert.equal(removed.ready, true); assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')), original);
  const again = await setup({ ...f.options, action: 'remove' }); assert.equal(again.changes[0].changed, false);
});

test('old direct Trillion hooks upgrade once; compound and unrelated shell commands are retained', t => {
  const f = fixture(t); const desired = desiredHooks({ ...f.options, runtime: process.execPath });
  const old = { hooks: {
    PreToolUse: [{ matcher: 'Edit|Bash', hooks: [{ type: 'command', command: 'node ~/.trillion/hooks/decide-before-building.mjs' }, { type: 'command', command: 'audit-other-work' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'node ~/.trillion/hooks/ask-trillion-first.mjs --harness claude-code' }] }, { hooks: [{ type: 'command', command: 'echo node ~/.trillion/hooks/record-every-message.mjs && keep-other-work' }] }],
  } };
  const next = mergeHooks(old, desired, { ...f.options, action: 'apply' });
  const commands = Object.values(next.hooks).flatMap(groups => groups.flatMap(group => group.hooks.map(hook => hook.command)));
  assert.deepEqual(commands.filter(command => command.includes('--run-hook')).map(command => commandWords(command)[3]).sort(), settings.hooks.map(hook => hook.id).sort());
  assert.ok(commands.includes('audit-other-work'));
  assert.ok(commands.includes('echo node ~/.trillion/hooks/record-every-message.mjs && keep-other-work'));
  assert.equal(commands.some(command => command === 'node ~/.trillion/hooks/decide-before-building.mjs'), false);
  assert.deepEqual(mergeHooks(next, desired, f.options), next);
  for (const row of desired) {
    const words = commandWords(row.hook.command);
    assert.deepEqual(words, [process.execPath, SELF, '--run-hook', row.id, '--harness', 'claude-code', '--payload', f.payload]);
    assert.ok('timeout' in row.hook); assert.equal('timeoutSec' in row.hook, false);
  }
  assert.equal(commandWords('node $(touch should-not-exist)'), null);
});

test('unknown hosts, unsupported platforms and disabled hooks never select another AI or change settings', async t => {
  const f = fixture(t);
  const unknown = await setup({ ...f.options, harness: 'future-cloud-ai', action: 'apply' });
  assert.equal(unknown.checks[0].status, 'unsupported'); assert.equal(existsSync(f.path), false);
  const linux = await setup({ ...f.options, platform: 'linux', action: 'apply' });
  assert.equal(linux.checks[0].status, 'unsupported'); assert.equal(existsSync(f.path), false);
  mkdirSync(dirname(f.path), { recursive: true }); writeFileSync(f.path, '{"disableAllHooks":true,"permissions":{"deny":["Bash"]}}');
  const before = readFileSync(f.path, 'utf8');
  const disabled = await setup({ ...f.options, action: 'apply' });
  assert.equal(disabled.checks.find(row => row.id === 'configuration').status, 'blocked');
  assert.equal(readFileSync(f.path, 'utf8'), before);
  await assert.rejects(setup({ ...f.options, action: 'inspect', trustHooks: true }), /explicit apply option/);
});

test('moving to a pinned checkout replaces former declared dispatchers and retires duplicate intake once', t => {
  const f = fixture(t);
  const previousInstaller = join(f.root, 'previous', 'harness', 'setup.mjs');
  mkdirSync(dirname(previousInstaller), { recursive: true });
  writeFileSync(join(dirname(previousInstaller), 'setup.json'), JSON.stringify(settings));
  writeFileSync(previousInstaller, 'throw new Error("previous installer must not execute");\n');
  const previous = desiredHooks({ ...f.options, runtime: process.execPath, installer: previousInstaller });
  const original = { model: 'keep', hooks: {} };
  for (const row of previous) (original.hooks[row.event] ??= []).push(row.group);
  const notices = previous.find(row => row.id === 'notices');
  original.hooks.UserPromptSubmit.push({ hooks: [{ ...notices.hook, command: notices.hook.command.replace("'notices'", "'intake'") }] });
  const unrelated = previous.find(row => row.id === 'transcript').hook.command.replace(previousInstaller, join(f.root, 'unrelated', 'harness', 'setup.mjs'));
  original.hooks.Stop.unshift({ hooks: [{ type: 'command', command: unrelated }] });
  const desired = desiredHooks({ ...f.options, runtime: process.execPath });
  const moved = mergeHooks(original, desired, f.options);
  const commands = Object.values(moved.hooks).flatMap(groups => groups.flatMap(group => group.hooks.map(hook => hook.command)));
  assert.equal(commands.length, desired.length + 1);
  assert.ok(commands.includes(unrelated));
  assert.equal(commands.some(command => command.includes(previousInstaller)), false);
  assert.equal(commands.some(command => command.includes("'intake'")), false);
  assert.equal(moved.model, 'keep');
  assert.deepEqual(mergeHooks(moved, desired, f.options), moved);
  writeFileSync(join(dirname(previousInstaller), 'setup.json'), JSON.stringify({ ...settings, mac_app: { ...settings.mac_app, team: 'OTHER' } }));
  const unowned = mergeHooks(original, desired, f.options);
  assert.ok(Object.values(unowned.hooks).flatMap(groups => groups.flatMap(group => group.hooks)).some(hook => hook.command.includes(previousInstaller)));
});

test('an exact local retired dispatcher is removed after its checkout and manifest are gone', async t => {
  const f = fixture(t);
  const retiredHooks = [
    { id: 'session', event: 'SessionStart' }, { id: 'intake', event: 'UserPromptSubmit' },
    { id: 'notices', event: 'UserPromptSubmit' }, { id: 'decision', event: 'PreToolUse' },
    { id: 'consult', event: 'Stop' }, { id: 'transcript', event: 'Stop' }, { id: 'sweep', event: 'Stop' },
  ];
  const oldInstaller = join(f.root, 'previous', 'harness', 'setup.mjs');
  const oldPayload = join(dirname(oldInstaller));
  const declaration = { installer: oldInstaller, payload: oldPayload, schema: settings.schema,
    mac_app: { identifier: settings.mac_app.identifier, team: settings.mac_app.team }, hooks: retiredHooks };
  const state = join(f.home, '.trillion', 'setup'); mkdirSync(state, { recursive: true });
  writeFileSync(join(state, settings.retired_dispatchers_file), JSON.stringify([declaration]));
  const hooks = {};
  for (const row of retiredHooks) {
    const command = [process.execPath, oldInstaller, '--run-hook', row.id, '--harness', 'claude-code', '--payload', oldPayload].join(' ');
    (hooks[row.event] ??= []).push({ hooks: [{ type: 'command', command }] });
  }
  const unrelated = [process.execPath, oldInstaller.replace('previous', 'unrelated'), '--run-hook', 'sweep', '--harness', 'claude-code', '--payload', oldPayload].join(' ');
  hooks.Stop.unshift({ hooks: [{ type: 'command', command: unrelated }] });
  mkdirSync(dirname(f.path), { recursive: true }); writeFileSync(f.path, JSON.stringify({ hooks }));
  const applied = await setup({ ...f.options, action: 'apply' });
  assert.equal(applied.checks.find(row => row.id === 'configuration').status, 'ready');
  const next = JSON.parse(readFileSync(f.path, 'utf8'));
  const commands = Object.values(next.hooks).flatMap(groups => groups.flatMap(group => group.hooks.map(hook => hook.command)));
  assert.equal(commands.some(command => command.includes(oldInstaller)), false);
  assert.ok(commands.includes(unrelated), 'a dispatcher outside the exact retired identity remains with its owner');
  assert.deepEqual(mergeHooks(next, desiredHooks({ ...f.options, runtime: process.execPath }), { ...f.options, retiredDispatchers: [declaration] }), next);
});

test('a payload update after review cannot authorize changed definitions or write configuration', async t => {
  const f = fixture(t);
  const options = { ...f.options, harness: 'codex', execute: () => okay };
  const before = await setup({ ...options, action: 'inspect' });
  const reviewedDefinitionHashes = before.checks.find(row => row.id === 'configuration').evidence.hooks.map(row => row.definition_hash);
  const path = configPath(hostFor('codex'), options);
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '{"model":"keep"}');
  writeFileSync(join(f.payload, settings.hooks[0].script), 'export const version = "updated-after-review";\n');
  const blocked = await setup({ ...options, action: 'apply', trustHooks: true, reviewedDefinitionHashes,
    openCodex: () => { throw new Error('must not open host before review matches'); } });
  assert.equal(blocked.checks.find(row => row.id === 'host-review').status, 'blocked');
  assert.deepEqual(blocked.changes, []); assert.equal(readFileSync(path, 'utf8'), '{"model":"keep"}');
  const after = await setup({ ...options, action: 'inspect' });
  const current = after.checks.find(row => row.id === 'configuration').evidence.hooks.map(row => row.definition_hash);
  assert.notDeepEqual(current, reviewedDefinitionHashes);
  const applied = await setup({ ...options, action: 'apply', trustHooks: true, reviewedDefinitionHashes: current,
    openCodex: () => { throw new Error('fixture host unavailable'); } });
  assert.equal(applied.changes[0].changed, true);
  assert.equal(applied.checks.some(row => row.id === 'host-review'), false);
  assert.equal(applied.checks.find(row => row.id === 'host-trust').status, 'unknown');
});

test('custom commands mentioning Trillion hooks are preserved and flagged before creating duplicate invocations', async t => {
  const f = fixture(t); mkdirSync(dirname(f.path), { recursive: true });
  const config = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'TOKEN=private-existing-value node ~/.trillion/hooks/record-every-message.mjs && other-work' }] }] } };
  const original = JSON.stringify(config); writeFileSync(f.path, original);
  const answer = await setup({ ...f.options, action: 'apply' });
  assert.equal(answer.ready, false); assert.equal(answer.changes.length, 0);
  assert.match(answer.checks.find(row => row.id === 'configuration').reason, /Custom hook commands/);
  assert.deepEqual(answer.checks.find(row => row.id === 'configuration').evidence.references, [{ event: 'Stop', group: 0, hook: 0, scripts: ['record-every-message.mjs'] }]);
  assert.equal(JSON.stringify(answer).includes('private-existing-value'), false);
  assert.equal(readFileSync(f.path, 'utf8'), original);
});

test('malformed or conflicting settings survive unchanged and a repaired retry succeeds', async t => {
  const f = fixture(t); mkdirSync(dirname(f.path), { recursive: true });
  writeFileSync(f.path, '{not json');
  const bad = await setup({ ...f.options, action: 'apply' });
  assert.equal(bad.checks.find(row => row.id === 'configuration').status, 'blocked');
  assert.equal(readFileSync(f.path, 'utf8'), '{not json');
  writeFileSync(f.path, '{"other":"before"}');
  assert.throws(() => writeConfig(f.path, current => ({ ...current, added: true }), { beforeCommit: () => writeFileSync(f.path, '{"other":"concurrent"}') }), /changed during setup/);
  assert.equal(readFileSync(f.path, 'utf8'), '{"other":"concurrent"}');
  assert.equal(existsSync(`${f.path}.trillion-setup.lock`), false);
  assert.equal(readdirSync(dirname(f.path)).some(name => name.endsWith('.part')), false);
  const retried = await setup({ ...f.options, action: 'apply' });
  assert.equal(retried.changes[0].changed, true); assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).other, 'concurrent');
});

test('a symlink or another active writer is not replaced', t => {
  const f = fixture(t); mkdirSync(dirname(f.path), { recursive: true });
  const target = join(f.home, 'person-settings.json'); writeFileSync(target, '{"kept":true}'); symlinkSync(target, f.path);
  assert.throws(() => writeConfig(f.path, () => ({})), /symbolic link/);
  assert.equal(readFileSync(target, 'utf8'), '{"kept":true}');
  rmSync(f.path); symlinkSync(join(f.home, 'missing-settings.json'), f.path);
  assert.throws(() => writeConfig(f.path, () => ({})), /symbolic link/);
  assert.equal(existsSync(join(f.home, 'missing-settings.json')), false);
  rmSync(f.path); writeFileSync(f.path, '{}'); writeFileSync(`${f.path}.trillion-setup.lock`, '{"pid":1}');
  assert.throws(() => writeConfig(f.path, () => ({ added: true })), /Another setup write/);
  assert.equal(readFileSync(f.path, 'utf8'), '{}');
});

test('a clean pinned payload loads, while dirty, wrong-ref and missing-dependency payloads are refused', t => {
  const f = fixture(t); const checkout = dirname(f.payload);
  const git = args => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git(['init']); git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture payload']);
  const commit = git(['rev-parse', 'HEAD']).trim();
  const good = verifyPayload({ payload: f.payload, sourceCommit: commit });
  assert.equal(good.status, 'ready'); assert.equal(good.evidence.commit, commit);
  assert.equal(verifyPayload({ payload: f.payload, sourceCommit: '0'.repeat(40) }).status, 'blocked');
  const marker = join(f.root, 'must-not-run');
  writeFileSync(join(f.payload, 'wake-sessions.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unexpected');\n`);
  assert.equal(verifyPayload({ payload: f.payload, sourceCommit: commit }).status, 'blocked'); assert.equal(existsSync(marker), false);
  writeFileSync(join(f.payload, 'wake-sessions.mjs'), 'import "./missing-dependency.mjs";\n');
  git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture missing dependency']);
  const missing = verifyPayload({ payload: f.payload, sourceCommit: git(['rev-parse', 'HEAD']).trim() });
  assert.equal(missing.status, 'blocked'); assert.equal(missing.evidence.dependency_check, 'failed');
});

test('a Git hook cannot route payload verification to a clean sibling instead of the dirty supplied checkout', t => {
  const f = fixture(t); const checkout = dirname(f.payload);
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const git = args => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', env: cleanEnv, stdio: ['ignore', 'pipe', 'ignore'] });
  git(['init']); git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Pinned fixture']);
  const commit = git(['rev-parse', 'HEAD']).trim();
  const sibling = join(f.root, 'clean-sibling');
  git(['clone', '--no-hardlinks', checkout, sibling]);
  writeFileSync(join(f.payload, 'wake-sessions.mjs'), 'export const dirty = true;\n');
  const held = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  try {
    process.env.GIT_DIR = join(sibling, '.git'); process.env.GIT_WORK_TREE = sibling;
    assert.equal(verifyPayload({ payload: f.payload, sourceCommit: commit }).status, 'blocked');
  } finally {
    for (const [name, value] of Object.entries(held)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('the known Mac bundle must pass both signature and Trillion identity before executing payload', t => {
  const f = fixture(t); const rules = structuredClone(settings);
  rules.mac_app.path = dirname(f.payload); rules.mac_app.payload = 'harness'; rules.mac_app.runtime = process.execPath;
  const calls = [];
  const refused = verifyPayload({ rules, execute: (command, args) => { calls.push({ command, args }); return args[0] === '-dv' ? { ...okay, stderr: `Identifier=${rules.mac_app.identifier}\nTeamIdentifier=OTHERTEAM\n` } : okay; } });
  assert.equal(refused.status, 'blocked'); assert.equal(calls.every(call => call.command === '/usr/bin/codesign'), true);
});

test('Codex trusts only its exact new enabled Trillion definitions and verifies its own readback', async t => {
  const f = fixture(t); const desired = desiredHooks({ ...f.options, harness: 'codex', runtime: process.execPath });
  const path = join(f.home, '.codex', 'hooks.json');
  const hooks = desired.map((row, index) => ({ key: `own-${index}`, eventName: hostFor('codex').event_names[row.event], matcher: row.group.matcher ?? null, timeoutSec: row.timeout, sourcePath: path, handlerType: 'command', command: row.hook.command, async: Boolean(row.async), enabled: index !== 1, isManaged: false, currentHash: `hash-${index}`, trustStatus: index === 0 || index === 1 ? 'untrusted' : 'trusted' }));
  hooks.unshift({ ...hooks[0], sourcePath: '/another/hooks.json', key: 'not-ours' });
  const writes = [];
  const client = { call: async (method, args) => {
    if (method === 'hooks/list') { assert.deepEqual(args, { cwds: [f.home] }); return { data: [{ cwd: f.home, hooks: structuredClone(hooks), errors: [], warnings: [] }] }; }
    assert.equal(method, 'config/batchWrite'); writes.push(args);
    for (const key of Object.keys(args.edits[0].value)) hooks.find(hook => hook.key === key).trustStatus = 'trusted';
    return { status: 'ok' };
  } };
  const before = await inspectCodex({ client, desired, path, cwd: f.home });
  assert.equal(writes.length, 0); assert.equal(before[0].status, 'pending');
  const after = await inspectCodex({ client, desired, path, cwd: f.home, trust: true });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], { edits: [{ keyPath: 'hooks.state', value: { 'own-0': { trusted_hash: 'hash-0' } }, mergeStrategy: 'upsert' }], reloadUserConfig: true });
  assert.equal(after[0].status, 'ready'); assert.equal(after[1].status, 'pending'); assert.match(after[1].reason, /disabled/);
  assert.equal(hooks.find(hook => hook.key === 'not-ours').trustStatus, 'untrusted');
  hooks.find(hook => hook.key === 'own-0').timeoutSec += 1;
  const changed = await inspectCodex({ client, desired, path, cwd: f.home, trust: true });
  assert.equal(changed[0].status, 'pending', 'metadata with another timeout must not be trusted or reported as this definition');
  assert.equal(writes.length, 1);
});

test('Codex errors and missing hook definitions stay unverified', async t => {
  const f = fixture(t); const desired = desiredHooks({ ...f.options, harness: 'codex', runtime: process.execPath });
  const client = { call: async method => { assert.equal(method, 'hooks/list'); return { data: [{ cwd: f.home, hooks: [], errors: [] }] }; } };
  const answer = await inspectCodex({ client, desired, path: '/fixture/hooks.json', cwd: f.home, trust: true });
  assert.equal(answer.every(row => row.status === 'pending'), true);
  await assert.rejects(inspectCodex({ client: { call: async () => ({ data: [] }) }, desired, path: '/fixture/hooks.json', cwd: f.home }), /readable hook inventory/);
});

test('retired decision and consultation payloads remain load-checked but are removed from host configuration', t => {
  const f = fixture(t);
  const retired = settings.retired_hooks;
  assert.deepEqual(retired.map(({ id }) => id).sort(), ['consult', 'decision', 'intake']);
  for (const hook of retired) {
    assert.ok(settings.payload.required.includes(hook.script));
    assert.ok(settings.payload.import_checks.includes(hook.script));
  }
  const desired = desiredHooks({ ...f.options, runtime: process.execPath });
  assert.deepEqual(desired.map(row => row.id), settings.hooks.map(row => row.id));
  const previous = { hooks: {
    PreToolUse: [{ hooks: [{ type: 'command', command: 'node ~/.trillion/hooks/decide-before-building.mjs' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'node ~/.trillion/hooks/ask-trillion-first.mjs --harness claude-code' }] },
      { hooks: [{ type: 'command', command: 'keep-existing-hook' }] }],
  } };
  const next = mergeHooks(previous, desired, { ...f.options, action: 'apply' });
  const commands = Object.values(next.hooks).flatMap(groups => groups.flatMap(group => group.hooks.map(hook => hook.command)));
  for (const hook of retired) assert.equal(commands.some(command => command.includes(hook.script)), false);
  assert.ok(commands.includes('keep-existing-hook'));
});

test('inspecting native services uses the app-owned helper and never starts a duplicate or reads key material', t => {
  const f = fixture(t); const app = settings.mac_app;
  mkdirSync(join(f.home, '.trillion', 'wake-sessions'), { recursive: true });
  writeFileSync(join(f.home, '.trillion', 'wake-sessions', 'settings.json'), '{"chosen_ai":"chosen-by-person","keep":"this"}');
  const appCommand = join(app.path, app.executable); const helperCommand = `${join(app.path, app.runtime)} ${join(app.path, app.payload, 'wake-sessions.mjs')} --key-stdin`;
  let duplicate = false; const calls = [];
  const execute = (command, args) => {
    calls.push({ command, args });
    if (command === '/usr/bin/security') { assert.equal(args.includes('-w'), false); return okay; }
    assert.equal(command, '/bin/ps');
    return { ...okay, stdout: ` 101 1 ${appCommand}\n 102 101 ${helperCommand}\n${duplicate ? '103 1 /usr/bin/node /another/harness/wake-sessions.mjs\n' : ''}` };
  };
  const first = localRuntimeChecks({ payload: f.payload, home: f.home, execute });
  assert.equal(first.find(row => row.id === 'helper').status, 'ready');
  assert.equal(first.find(row => row.id === 'helper').evidence.delivery, 'not-tested');
  duplicate = true;
  assert.equal(localRuntimeChecks({ payload: f.payload, home: f.home, execute }).find(row => row.id === 'helper').status, 'blocked');
  assert.equal(calls.every(call => ['/usr/bin/security', '/bin/ps'].includes(call.command)), true);
  assert.equal(readFileSync(join(f.home, '.trillion', 'wake-sessions', 'settings.json'), 'utf8'), '{"chosen_ai":"chosen-by-person","keep":"this"}');
});

test('the selected harness respects its own config-home override', t => {
  const f = fixture(t); const custom = join(f.home, 'my-codex');
  assert.equal(configPath(hostFor('codex'), { home: f.home, env: { CODEX_HOME: custom } }), join(custom, 'hooks.json'));
  assert.equal(configPath(hostFor('claude-code'), { home: f.home, env: { CLAUDE_CONFIG_DIR: custom } }), join(custom, 'settings.json'));
});

// The current dispatcher still carries a hook's output untouched; retirement does not weaken execution evidence.
test('retained-hook dispatcher preserves output and invalidates changed or failed executions without recording input', t => {
  const f = fixture(t);
  const hook = settings.hooks.find(row => row.id === 'session');
  const script = join(f.payload, hook.script);
  writeFileSync(script, `process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('{"decision":"block"}\\n'); process.stderr.write('fixture policy\\n'); });\n`);
  const input = JSON.stringify({ hook_event_name: hook.event, session_id: 'fixture', text: 'private-prompt-contents' });
  const direct = spawnSync(process.execPath, [script, ...hook.args.map(arg => arg.replaceAll('{harness}', 'claude-code'))], { input, encoding: 'utf8' });
  const wrapped = runConfiguredHook({ ...f.options, id: hook.id, input, execute: undefined });
  assert.deepEqual(wrapped, { status: direct.status, stdout: direct.stdout, stderr: direct.stderr });
  let desired = desiredHooks({ ...f.options, runtime: process.execPath });
  assert.equal(hookEvidence({ ...f.options, desired }).find(row => row.id === `ran-${hook.id}`).status, 'ready');
  const receipt = readFileSync(join(f.home, settings.state_folder, 'observed', 'claude-code', `${hook.id}.json`), 'utf8');
  assert.equal(receipt.includes('private-prompt-contents'), false);
  writeFileSync(script, readFileSync(script, 'utf8') + '// changed definition\n');
  desired = desiredHooks({ ...f.options, runtime: process.execPath });
  assert.equal(hookEvidence({ ...f.options, desired }).find(row => row.id === `ran-${hook.id}`).status, 'pending');
  const failed = runConfiguredHook({ ...f.options, id: hook.id, input, execute: () => ({ status: 7, stdout: '', stderr: 'fixture failure' }) });
  assert.equal(failed.status, 7);
  assert.equal(hookEvidence({ ...f.options, desired }).find(row => row.id === `ran-${hook.id}`).status, 'pending');
});

test('retained hooks another runner executes count from their own receipts without duplicate registration', async t => {
  const f = fixture(t);
  const { buildSync } = await import('esbuild');
  buildSync({ entryPoints: [join(ROOT, 'harness/hook-run-receipt.mjs')], outfile: join(f.payload, 'hook-run-receipt.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22' });
  writeFileSync(join(f.payload, 'setup.json'), JSON.stringify(settings));
  const selected = settings.hooks.filter(row => ['session', 'notices'].includes(row.id));
  for (const hook of selected) {
    const script = join(f.payload, hook.script);
    writeFileSync(script, `import { readFileSync } from 'node:fs'; import { keepHookRunOnExit } from './hook-run-receipt.mjs'; keepHookRunOnExit(import.meta.url, JSON.parse(readFileSync(0, 'utf8')));\n`);
    const answer = spawnSync(process.execPath, [script, ...hook.args.map(arg => arg.replaceAll('{harness}', 'claude-code'))], {
      input: JSON.stringify({ hook_event_name: hook.event, transcript_path: join(f.home, '.claude', 'projects', 'fixture', 'session.jsonl'), text: 'private-prompt-contents' }), encoding: 'utf8', env: { ...process.env, HOME: f.home },
    });
    assert.equal(answer.status, 0, answer.stderr);
  }
  const runs = join(f.home, settings.state_folder, 'observed', 'claude-code', 'runs');
  const kept = readdirSync(runs).map(name => readFileSync(join(runs, name), 'utf8'));
  assert.equal(kept.length, 2);
  for (const receipt of kept) { assert.equal(receipt.includes('private-prompt-contents'), false); assert.equal(receipt.includes(join(f.home, '.claude', 'projects')), false); assert.equal(JSON.parse(receipt).route, 'other'); }
  const applied = await setup({ ...f.options, action: 'apply' });
  const hooks = applied.checks.find(row => row.id === 'configuration').evidence.hooks;
  assert.deepEqual(hooks.filter(row => row.route === 'another-hook-runner').map(row => row.id).sort(), ['notices', 'session']);
  const commands = Object.values(JSON.parse(readFileSync(f.path)).hooks).flatMap(groups => groups.flatMap(group => group.hooks.map(hook => hook.command)));
  assert.equal(commands.length, settings.hooks.length - selected.length);
  assert.equal((await setup({ ...f.options, action: 'apply' })).changes[0].changed, false);
  writeFileSync(join(f.payload, selected[0].script), readFileSync(join(f.payload, selected[0].script), 'utf8') + '// changed definition\n');
  const updated = (await setup({ ...f.options, action: 'apply' })).checks.find(row => row.id === 'configuration').evidence.hooks;
  assert.equal(updated.find(row => row.id === selected[0].id).route, undefined);
  assert.equal(updated.find(row => row.id === selected[1].id).route, 'another-hook-runner');
});

// A hook that did not finish said nothing about the action: the hosts read exit 1 as "go on", so a row that guards
// something declares on_failure "block" and is answered with exit 2 and the reason. The default stays open.
test('a hook that times out or crashes lets the action go on unless its row says on_failure block, and always says it timed out', t => {
  const f = fixture(t);
  const hook = settings.hooks.find(row => row.id === 'notices');
  const input = JSON.stringify({ hook_event_name: hook.event, session_id: 'fixture' });
  const timedOut = () => ({ error: Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, stdout: '', stderr: '' });
  const open = runConfiguredHook({ ...f.options, id: hook.id, input, execute: timedOut });
  assert.equal(open.status, 1);
  assert.match(open.stderr, new RegExp(`hook ${hook.id} did not finish in ${hook.timeout} seconds\\.`));
  const guarded = { ...settings, hooks: settings.hooks.map(row => (row.id === hook.id ? { ...row, on_failure: 'block' } : row)) };
  const blocked = runConfiguredHook({ ...f.options, rules: guarded, id: hook.id, input, execute: timedOut });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /its row says the action stops when it fails/);
  const finished = runConfiguredHook({ ...f.options, rules: guarded, id: hook.id, input, execute: () => ({ status: 7, stdout: '', stderr: 'fixture failure' }) });
  assert.deepEqual(finished, { status: 7, stdout: '', stderr: 'fixture failure' });
  assert.throws(() => desiredHooks({ ...f.options, rules: { ...settings, hooks: [{ ...hook, on_failure: 'maybe' }] } }), /on_failure is allow/);
});
