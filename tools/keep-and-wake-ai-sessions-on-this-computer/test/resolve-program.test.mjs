// test/resolve-program.test.mjs
// Finding the program a command names (argv[0]) for a helper the Mac app starts under launchd with a short PATH:
// resolveProgram() in harness/take-open-work.mjs looks on this PATH, then in the folders take-open-work.json program_paths
// names (~ expanded), then by the person's login shell, and gives null when none has it. The taker and the sorter treat a
// null as a wall, not a crash: no job is claimed for that AI, its card says "<program> is not installed where Trillion
// looks (<folders tried>)", and the next of the person's AIs runs instead. The wake-sessions run() answers the same way.
// Temporary folders are made under the work folder's .test-tmp (never /tmp); the fake login shells are small scripts there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import settingsFile from '../harness/take-open-work.json' with { type: 'json' };
import { chosenAi, childEnv, foldersTried, loginShellLookup, plan, programFolders, programMissingWords, resolveProgram, runPass } from '../harness/take-open-work.mjs';
import { run } from '../harness/wake-sessions.mjs';

const NOW = '2026-09-30T10:00:00.000Z';
const workFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratchRoot = path.join(workFolder, '.test-tmp');
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = (t, name) => {
  const folder = fs.mkdtempSync(path.join(scratchRoot, `resolve-${name}-`));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
};
const executable = (file, text) => { fs.writeFileSync(file, text, { mode: 0o755 }); fs.chmodSync(file, 0o755); return file; };
const job = (id, extra = {}) => ({ handoff_id: id, state: 'open', status: 'open', to_agent: null, input: {}, handed_at: `2026-09-30T0${id.slice(-1)}:00:00.000Z`, hold_until: null, ...extra });
const settings = { ...settingsFile, max_concurrent: 2, use_ai: 'codex', working_folder: '/work', triage: undefined, resting: {}, trouble: {}, work_mcp: undefined };
const base = { agents: [], settings, started: new Map(), today: 0, running: 0, chats: new Map(), agent_id: 'take-open-work-mac', computer: 'Mac', now: NOW };
const never = () => { throw new Error('this lookup should not be needed'); };

test('a program on this PATH is found there, and the login shell is not asked', () => {
  const env = { PATH: '/usr/bin:/opt/tools' };
  assert.equal(resolveProgram('codex', { env, exists: p => p === '/opt/tools/codex', shellLookup: never }), '/opt/tools/codex');
  assert.equal(resolveProgram('codex', { env: { PATH: '/opt/tools:/opt/other' }, exists: p => p === '/opt/tools/codex' || p === '/opt/other/codex', shellLookup: never }), '/opt/tools/codex', 'the first PATH folder that has it wins');
});

test('a program in a program_paths folder is found there, with ~ expanded, after this PATH', () => {
  const wanted = path.join(homedir(), '.superconductor', 'bin', 'codex');
  assert.ok(settingsFile.program_paths.includes('~/.superconductor/bin'), 'the data names where the Codex on this Mac is installed');
  assert.ok(programFolders().includes(path.join(homedir(), '.superconductor', 'bin')));
  assert.ok(programFolders().every(folder => !folder.startsWith('~')), 'every folder the data names is expanded');
  assert.equal(resolveProgram('codex', { env: { PATH: '/usr/bin:/bin' }, exists: p => p === wanted, shellLookup: never }), wanted);
  assert.equal(resolveProgram('codex', { env: { PATH: '/usr/bin' }, exists: p => p === '/usr/bin/codex' || p === wanted, shellLookup: never }), '/usr/bin/codex', 'a PATH folder is looked in before program_paths');
});

test('a program only the person\'s login shell finds is found there', () => {
  const shellLookup = name => (name === 'claude' ? '/Users/example/.nvm/bin/claude' : null);
  assert.equal(resolveProgram('claude', { env: { PATH: '/usr/bin:/bin' }, exists: () => false, shellLookup }), '/Users/example/.nvm/bin/claude');
});

test('the login shell is asked with -lc, its last line is taken only when it is an absolute, runnable file', t => {
  const folder = scratch(t, 'shell');
  const tool = executable(path.join(folder, 'codex'), '#!/bin/sh\n');
  const shellThat = (name, text) => executable(path.join(folder, name), `#!/bin/sh\n${text}\n`);
  // A profile that prints a warning first: the path is the last line.
  assert.equal(loginShellLookup('codex', { SHELL: shellThat('shell-path.sh', `echo "a line from the profile"\necho ${tool}`) }), tool);
  // A relative answer, an absolute file that is not there, a failing shell, and a name that is not a plain program name: all null.
  assert.equal(loginShellLookup('codex', { SHELL: shellThat('shell-relative.sh', 'echo codex') }), null);
  assert.equal(loginShellLookup('codex', { SHELL: shellThat('shell-missing.sh', `echo ${path.join(folder, 'not-there')}`) }), null);
  assert.equal(loginShellLookup('codex', { SHELL: shellThat('shell-fails.sh', 'exit 1') }), null);
  assert.equal(loginShellLookup('codex; echo hi', { SHELL: shellThat('shell-never.sh', `echo ${tool}`) }), null);
});

test('a program nobody finds is null; an absolute name is itself, whether or not it is there', () => {
  assert.equal(resolveProgram('codex', { env: { PATH: '/usr/bin' }, exists: () => false, shellLookup: () => null }), null);
  assert.equal(resolveProgram('a/relative/codex', { env: { PATH: '/usr/bin' }, exists: () => true, shellLookup: never }), null);
  assert.equal(resolveProgram('/opt/somewhere/claude', { env: { PATH: '' }, exists: () => false, shellLookup: never }), '/opt/somewhere/claude');
  assert.equal(resolveProgram(process.execPath), process.execPath);
});

test('the words for a program nobody finds name it and every folder tried', () => {
  const words = programMissingWords('codex', { PATH: '/usr/bin:/bin' });
  assert.match(words, /^codex is not installed where Trillion looks \(\/usr\/bin, \/bin, /);
  assert.ok(words.includes('/opt/homebrew/bin') && words.includes(path.join(homedir(), '.superconductor', 'bin')), 'the folders of the data are named');
  assert.ok(words.endsWith(')'));
  assert.deepEqual(foldersTried({ PATH: '/usr/bin:/usr/bin' }).slice(0, 1), ['/usr/bin'], 'a folder is named once');
});

test('the environment a started program gets names the same folders, so a program that starts another still finds it', () => {
  const env = childEnv({ PATH: '/usr/bin:/bin', HOME: '/h', ANTHROPIC_API_KEY: 'kept-out-by-the-caller' });
  assert.equal(env.HOME, '/h');
  assert.ok(env.PATH.startsWith('/usr/bin:/bin:'));
  assert.ok(env.PATH.split(':').includes('/opt/homebrew/bin'));
});

test('the AI that takes unnamed work is the next of the person\'s AIs whose program is installed; with none, nothing is claimed', () => {
  const ordered = { ...settings, ai_order: ['codex', 'claude'] };
  const onlyClaude = row => row.id === 'claude';
  assert.equal(chosenAi(ordered, NOW, onlyClaude).id, 'claude');
  assert.equal(chosenAi(ordered, NOW, () => false), null);
  assert.equal(chosenAi(ordered, NOW).id, 'codex', 'with no check every chosen AI is runnable, as before');
  const through = plan({ ...base, settings: ordered, open: [job('h1')], runnable: onlyClaude });
  assert.equal(through.start[0].ai_id, 'claude');
  assert.equal(through.start[0].command[0], 'claude');
  const none = plan({ ...base, settings: ordered, open: [job('h1')], runnable: () => false });
  assert.deepEqual(none.start, []);
  assert.equal(none.left['no chosen AI is installed here'], 1);
});

test('a chat whose AI is not installed waits: its work is not claimed for another AI', () => {
  const chats = new Map([['claude-code:abc', { cwd: '/work', idle: true, bytes: 10 }]]);
  const open = [job('h2', { input: { arrived: { source_id: 'claude-code:abc' } } })];
  const waiting = plan({ ...base, settings, chats, open, runnable: row => row.id !== 'claude-code' });
  assert.deepEqual(waiting.start, []);
  assert.equal(waiting.left['its AI is not installed here'], 1);
  const resumed = plan({ ...base, settings, chats, open, runnable: () => true });
  assert.equal(resumed.start[0].mode, 'chat');
});

test('a pass whose chosen AI has no program runs the next AI, and the card says what is missing', async t => {
  const folder = scratch(t, 'next');
  const calls = [];
  const spawned = [];
  const call = async (path, body) => {
    calls.push([path, body]);
    if (path === '/handoffs/open-page') return { work: [job('h1')], agents: [], next_after: null };
    if (path === '/handoffs/take') return { handoff: { handoff_id: 'h1' } };
    if (path === '/handoffs/read') return { handoff: { handoff_id: 'h1', state: 'taken', taken_by: 'take-open-work-mac', generation: 1 } };
    return {};
  };
  const spawnRun = (command, args, options) => {
    spawned.push([command, ...args]);
    assert.ok(options.env.PATH.includes('/opt/homebrew/bin'), 'the started program is given the folders the data names');
    return { pid: process.pid, on: (name, fn) => { if (name === 'close') setTimeout(() => fn(0), 5); } };
  };
  const locate = name => (name === 'claude' ? '/fake/bin/claude' : null);
  const pass = await runPass({ locate, settings: { ...settings, ai_order: ['codex', 'claude'], state_folder: folder }, call, computer: 'Mac', spawnRun, now: () => new Date(NOW) });
  assert.deepEqual(pass.started, ['h1']);
  assert.deepEqual(spawned.map(([command]) => command), ['/fake/bin/claude']);
  await Promise.all(pass.runs);
  const card = calls.filter(([p]) => p === '/agents/publish').at(-1)[1];
  assert.equal(card.name, 'Claude Code on Mac');
  assert.equal(card.capacity.trouble[0].ai, 'codex');
  assert.match(card.description, /Codex: codex is not installed where Trillion looks \(/);
  assert.match(JSON.parse(fs.readFileSync(path.join(folder, 'trouble.json'), 'utf8')).codex.what, /^codex is not installed where Trillion looks \(/);
  assert.equal(fs.existsSync(path.join(folder, 'resting.json')), false, 'a missing program is not a usage limit: nothing rests');
});

test('with no AI\'s program found anywhere, nothing is claimed or taken, and the card names what is missing', async t => {
  const folder = scratch(t, 'none');
  const calls = [];
  const call = async (path, body) => {
    calls.push([path, body]);
    if (path === '/handoffs/open-page') return { work: [job('h1')], agents: [], next_after: null };
    return {};
  };
  const pass = await runPass({ locate: () => null, settings: { ...settings, ai_order: ['codex'], state_folder: folder }, call, computer: 'Mac', spawnRun: () => { throw new Error('nothing should be started'); }, now: () => new Date(NOW) });
  assert.deepEqual(pass.started, []);
  assert.equal(pass.left['no chosen AI is installed here'], 1);
  assert.equal(calls.some(([p]) => p === '/handoffs/take'), false, 'no job is taken for an AI that cannot run');
  const card = calls.filter(([p]) => p === '/agents/publish').at(-1)[1];
  assert.match(card.description, /Codex: codex is not installed where Trillion looks \(/);
});

test('the card clears once the program is found', async t => {
  const folder = scratch(t, 'cleared');
  fs.writeFileSync(path.join(folder, 'trouble.json'), JSON.stringify({ codex: { at: NOW, what: programMissingWords('codex') } }));
  const calls = [];
  const call = async (path, body) => { calls.push([path, body]); return path === '/handoffs/open-page' ? { work: [], agents: [], next_after: null } : {}; };
  const before = { ...settings, ai_order: ['codex'], state_folder: folder, trouble: { codex: { at: NOW, what: programMissingWords('codex') } } };
  await runPass({ locate: name => `/fake/bin/${name}`, settings: before, call, computer: 'Mac', spawnRun: () => { throw new Error('nothing to start'); }, now: () => new Date(NOW) });
  const card = calls.filter(([p]) => p === '/agents/publish').at(-1)[1];
  assert.equal(card.capacity.trouble, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'trouble.json'), 'utf8')).codex, undefined);
});

test('a program that is installed nowhere is answered as a wall by run(), never started, and an absolute program still runs', async () => {
  const missing = await run(['take-open-work-no-such-program-xyz']);
  assert.equal(missing.code, -1);
  assert.match(missing.stderr, /^take-open-work-no-such-program-xyz is not installed where Trillion looks \(/);
  const ok = await run([process.execPath, '-e', 'process.stdout.write("ran")']);
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, 'ran');
});
