import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeHashCodeHexFromBytes } from '../do-work/packs/read-data/identity.mjs';
import settings from '../do-work/command.json' with { type: 'json' };
import {
  CommandError, agentOf, aiOf, aiRecordOf, allPages, groupsOf, argumentsFor, computerNameOf, computerOf, credentialFor, doorFor, giveNote, grantStore, holdingOf, installProgram,
  installSkills, keyStore, main, modelOf, namesOf, parseArgs, pkce, placeOf, providerOf, publishRecord, render, repliesOf, taskLines,
  opWhole, serveOnce, signInWithBrowser, addPersonHere, findAgentSocket, audiencesOf, stateOf, engineClient, waitFor, toolCall, speakFor } from '../do-work/command.mjs';
import { recordStore, taskDoorOps } from '../test-fixtures/task-records.mjs';

speakFor({ cli: 'example', site_name: 'Example' });

const KEY = `nm_${'ab'.repeat(32)}`;
const ACCOUNT = 'f'.repeat(64);
const me = { agent_id: 'claude-code-on-mac', ai_id: 'ai:claude-code-on-mac', held_as: [], harness: 'Claude Code', app: 'Claude Code', model: null, provider: 'Anthropic', computer: 'Mac' };
const place = () => ({ repository: 'example', branch: 'main' });
const home = () => mkdtempSync(join(tmpdir(), 'example-cli-test-'));
const task = 'record:calendar-task:1';
const quick = { ...settings, retry: { ...settings.retry, count: 3, first_seconds: 0, most_seconds: 0 } };
const noWait = async () => {};
const noGrants = { where: 'test sign-in', read: () => null, write: () => {}, forget: () => {} };

// A stand-in engine door: /mcp answers initialize with the account in _meta, and do_one_thing_in_my_account from `ops`
// (a function per "address method"); /oauth/* and /authorize from `oauth`. Bearers in `bearers` are admitted.
async function fakeDoor({ ops = {}, oauth = null, sse = false, bearers = [KEY], status = null, holdsAddedOnly = false, why = null } = {}) {
  const calls = [];
  const added = [];
  const held = new Set();
  const order = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (code, value, type = 'application/json') => response.writeHead(code, { 'content-type': type }).end(typeof value === 'string' ? value : JSON.stringify(value));
    if (url.pathname.startsWith('/.well-known/') || url.pathname.startsWith('/api/auth/')) return oauth(url, raw, request, send);
    if (status) return send(status, { error: 'refused' });
    if (!bearers.some(bearer => request.headers.authorization === `Bearer ${bearer}`)) return send(401, { error: 'Bearer authentication is required', ...(why ? { why } : {}) });
    if (url.pathname === '/persons/add') { order.push('persons/add'); added.push(request.headers.authorization); held.add(request.headers.authorization); return send(200, { person: 'person-1', added: added.length === 1 }); }
    if (url.pathname !== '/mcp') return send(404, { error: 'Not found' });
    // A main-built engine serves a person only after /persons/add held them.
    if (holdsAddedOnly && !held.has(request.headers.authorization)) return send(401, { error: 'Bearer authentication is required' });
    const message = JSON.parse(raw);
    let result;
    if (message.method === 'initialize') order.push('whoami');
    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, serverInfo: { name: 'fake' }, _meta: { [settings.engine.account_meta]: { account_id: ACCOUNT } } };
    else {
      const args = message.params.arguments;
      calls.push({ name: message.params.name, ...args });
      // A call names its method; the stand-in finds the owner by it, as the engine does (an address is only sent to pass a method on).
      const handler = ops[`${args.address ?? (args.method.startsWith('tools:') ? '@tools' : '')} ${args.method}`];
      const answer = handler ? await handler(args.input, args, calls) : { refused: `No ${args.method} at ${args.address}` };
      // An HTTP status is a number; a record's own `status` word is an answer, not a status.
      if (typeof answer?.status === 'number') return send(answer.status, 'busy', 'text/plain');
      // A refusal the engine names by a code alone answers as the engine does: { code, outcome } and no words.
      result = answer?.code ? { isError: true, content: [{ type: 'text', text: 'The resource operation was refused.' }], structuredContent: { code: answer.code, outcome: 'not_started' } }
        : answer?.refused ? { isError: true, content: [{ type: 'text', text: answer.refused }], structuredContent: { error: { message: answer.refused, retryable: answer.retryable ?? false } } }
        : { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer };
    }
    const reply = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
    return sse ? send(200, `event: message\ndata: ${reply}\n\n`, 'text/event-stream') : send(200, reply);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // The engine's own unix socket answers the same requests, as the real engine answers /persons/add only there.
  const socket = join(mkdtempSync(join(tmpdir(), 'td-')), 's');
  const onSocket = createServer(server.listeners('request')[0]);
  await new Promise(resolve => onSocket.listen(socket, resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, mcp: `${origin}/mcp`, socket, calls, added, order, close: () => Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => onSocket.close(resolve))]) };
}
const keyCredential = { kind: 'key', bearer: KEY, where: 'test' };
const doorAt = (mcp, extra = {}) => ({ mcp, origin: new URL(mcp).origin, name: `the door ${mcp}`, local: false, public: false, localMcp: null, ...extra });
const seamsFor = (folder = home(), extra = {}) => ({ store: { read: () => KEY, where: 'test key' }, grants: noGrants, state: stateOf({ home: folder }), env: { CLAUDECODE: '1' },
  place, localDoor: () => null, agentSocket: () => null, computerName: 'Mac', model: null, wait: noWait, ...extra });

test('arguments: words and flags, with -- ending them', () => {
  assert.deepEqual(parseArgs(['send', 'any', 'fix', 'the', 'build', '--priority', '3', '--json']), { words: ['send', 'any', 'fix', 'the', 'build'], flags: { priority: '3', json: true }, rest: [] });
  assert.deepEqual(parseArgs(['serve', '--as=me', '--', 'claude', '-p', '--json']), { words: ['serve'], flags: { as: 'me' }, rest: ['claude', '-p', '--json'] });
  assert.throws(() => parseArgs(['send', '--as']), /--as needs a value/);
});

test('each task command is one read or one move, with the input its Workshop task tool is given', () => {
  const call = (line, extra = {}) => argumentsFor(line[0], { words: parseArgs(line).words.slice(1), flags: parseArgs(line).flags }, { me, requestKey: 'k1', ...extra });
  assert.deepEqual(call(['give', 'fix', 'the', 'build']).input, { as: me.ai_id, key: 'k1', description: 'fix the build' });
  const review = call(['give', 'review', '--to', 'ai:codex-on-mac', '--to', 'person:someone', '--priority', 'high', '--outcome', 'tests pass', '--title', 'Review']);
  assert.deepEqual(review.input, { as: me.ai_id, key: 'k1', description: 'review', title: 'Review', assignees: ['ai:codex-on-mac', 'person:someone'], priority: 'high', outcome: 'tests pass' });
  assert.deepEqual(review.read.ids, [{ type: 'ai', id: 'ai:codex-on-mac' }, { type: 'person', id: 'person:someone' }], 'every named assignee is read with the move');
  assert.equal(call(['give', 'x', '--key', 'mine']).input.key, 'mine');
  assert.throws(() => call(['give']), /Say the task/);
  assert.deepEqual(call(['tasks']).input, { limit: settings.tasks.list_limit });
  assert.deepEqual(call(['tasks', task]).input, { id: task });
  const listed = call(['tasks', '--status', 'To do', '--taken-by', 'ai:codex-on-mac', '--limit', '5']);
  assert.deepEqual(listed.input, { status: 'To do', taken_by: 'ai:codex-on-mac', limit: 5 });
  assert.ok(listed.read.tasks.statuses.includes('To do'), 'a listing by state reads the words that state is written with');
  assert.deepEqual(call(['take']).input, { as: me.ai_id });
  assert.deepEqual(call(['take', task, '--only-mine']).input, { as: me.ai_id, id: task, only_mine: true });
  assert.deepEqual(call(['finish', task, 'done.', 'All', 'green.']), { call: 'finish', input: { as: me.ai_id, id: task, action: 'finish', result: 'done. All green.', summary: 'done. All green.' }, read: { ids: [] } });
  const planned = join(home(), 'acceptance.json');
  writeFileSync(planned, JSON.stringify({ outcome: 'Done', target: { type: 'calendar-task', id: task }, rules: [] }));
  assert.deepEqual(call(['plan', task, '--acceptance-file', planned]).input, { as: me.ai_id, id: task, action: 'plan', acceptance: { outcome: 'Done', target: { type: 'calendar-task', id: task }, rules: [] } });
  assert.throws(() => call(['plan', task]), /acceptance-file/);
  assert.deepEqual(call(['fail', task, 'no', 'access']).input, { as: me.ai_id, id: task, action: 'fail', result: 'no access' });
  assert.deepEqual(call(['stuck', task, '--clear']).input, { as: me.ai_id, id: task, action: 'unstuck' });
  assert.deepEqual(call(['stuck', task, 'needs', 'a', 'sign-in']).input, { as: me.ai_id, id: task, action: 'stuck', words: 'needs a sign-in' });
  assert.deepEqual(call(['release', task, '--because', 'busy']).input, { as: me.ai_id, id: task, action: 'release', because: 'busy' });
  assert.throws(() => call(['withdraw', task]), /--reason/);
  assert.deepEqual(call(['withdraw', task, '--reason', 'not needed']).input, { as: me.ai_id, id: task, action: 'withdraw', because: 'not needed' });
  assert.deepEqual(call(['remove', task]).input, { as: me.ai_id, id: task, action: 'remove' });
  const handed = call(['hand-on', task, '--to', 'person:someone', '--because', 'Yours now']);
  assert.deepEqual(handed.input, { as: me.ai_id, id: task, action: 'hand-on', assignees: ['person:someone'], because: 'Yours now' });
  assert.deepEqual(handed.read.ids, [{ type: 'person', id: 'person:someone' }]);
  assert.throws(() => call(['hand-on', task]), /--to/);
  assert.throws(() => call(['hand-on', task, '--to', 'someone']), /record id/, 'a hand-on names a record id, never a bare name');
  assert.throws(() => call(['dance']), error => error instanceof CommandError && error.status === 2);
  assert.deepEqual(Object.values(settings.tasks.tools).sort(), ['tool:change-a-task', 'tool:finish-a-task', 'tool:give-a-task', 'tool:see-tasks', 'tool:see-who-can-take-work', 'tool:take-a-task']);
});

test('the agent id comes from --as, EXAMPLE_AGENT, or the AI app running the command', () => {
  assert.equal(computerOf('Work-Laptop.local'), 'work-laptop');
  assert.equal(computerOf('Mac.localdomain'), 'mac');
  assert.equal(agentOf({ env: { CLAUDECODE: '1' }, computer: 'mac', model: null }).agent_id, 'claude-code-on-mac');
  assert.equal(agentOf({ env: {}, computer: 'mac', model: null }).agent_id, 'terminal-on-mac');
  assert.equal(agentOf({ env: { EXAMPLE_AGENT: 'lane-7', CLAUDECODE: '1' }, computer: 'mac', model: null }).agent_id, 'lane-7');
  assert.equal(agentOf({ as: 'reviewer', env: { EXAMPLE_AGENT: 'lane-7' }, computer: 'mac', model: null }).agent_id, 'reviewer');
});

test('each chat session has its own agent id when its app names the session, else the computer id stays', () => {
  const claude = agentOf({ env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: '5B1F0C2E-8A4D-4E3B-9C1A-7D2E6F4A9B10' }, computer: 'mac', model: null });
  assert.equal(claude.agent_id, 'claude-code-7d2e6f4a9b10-on-mac');
  assert.deepEqual(claude.held_as, ['claude-code-on-mac'], 'jobs taken under the computer id are still this session\'s to finish');
  // Codex thread ids are UUID v7: two threads started in the same minute share their first letters, never their last.
  const one = agentOf({ env: { CODEX_THREAD_ID: '019a2b3c-4d5e-7f60-8123-456789abcdef' }, computer: 'mac', model: null });
  const two = agentOf({ env: { CODEX_THREAD_ID: '019a2b3c-4d5e-7f60-8999-0123456789ab' }, computer: 'mac', model: null });
  assert.equal(one.agent_id, 'codex-456789abcdef-on-mac');
  assert.notEqual(one.agent_id, two.agent_id);
  assert.equal(agentOf({ env: { CODEX_SESSION_ID: 'abc' }, computer: 'mac', model: null }).agent_id, 'codex-abc-on-mac');
  const cursor = agentOf({ env: { CURSOR_AGENT: '1' }, computer: 'mac', model: null });
  assert.deepEqual([cursor.agent_id, cursor.held_as, cursor.session], ['cursor-on-mac', [], null]);
  assert.equal(agentOf({ env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: '--' }, computer: 'mac', model: null }).agent_id, 'claude-code-on-mac', 'a session variable with no letters or digits names no session');
  const chosen = agentOf({ env: { EXAMPLE_AGENT: 'lane-7', CLAUDE_CODE_SESSION_ID: 's1', CLAUDECODE: '1' }, computer: 'mac', model: null });
  assert.deepEqual([chosen.agent_id, chosen.held_as], ['lane-7', []], 'a chosen id has no other id');
  assert.equal(agentOf({ as: 'a'.repeat(200), env: {}, model: null }).agent_id.length, 200);
  assert.throws(() => agentOf({ as: 'a'.repeat(201), env: {}, model: null }), error => error.status === 2 && /1 to 200 characters/.test(error.message));
  assert.throws(() => agentOf({ as: ' padded', env: {}, model: null }), /no space at either end/);
  assert.equal(agentOf({ env: { EXAMPLE_AGENT: '' }, computer: 'mac', model: null }).agent_id, 'terminal-on-mac', 'an empty EXAMPLE_AGENT chooses nothing');
});

test('an AI carries facts only: its app, model, provider and computer; no name is made here', () => {
  assert.equal(providerOf('claude-opus-5-5'), 'Anthropic');
  assert.equal(providerOf('gpt-6.1-sol'), 'OpenAI');
  assert.equal(providerOf('some-local-model'), null);
  assert.equal(providerOf(null), null);
  // The model the app runs: its variable first, else its own config file; a context-size mark is not part of the model.
  const claudeRow = settings.agents.find(row => row.agent === 'claude-code');
  const codexRow = settings.agents.find(row => row.agent === 'codex');
  assert.equal(modelOf(claudeRow, { env: { ANTHROPIC_MODEL: 'claude-opus-5-5' }, read: () => { throw new Error('not read'); } }), 'claude-opus-5-5');
  assert.equal(modelOf(claudeRow, { env: {}, home: '/h', read: path => (path === '/h/.claude/settings.json' ? '{"model":"claude-opus-5-5[1m]"}' : '') }), 'claude-opus-5-5');
  assert.equal(modelOf(codexRow, { env: { CODEX_HOME: '/c' }, read: path => (path === '/c/config.toml' ? 'approval = "x"\nmodel = "gpt-6.1-sol"\n' : '') }), 'gpt-6.1-sol');
  assert.equal(modelOf(codexRow, { env: {}, home: '/h', read: () => { throw new Error('absent'); } }), null);
  const codex = agentOf({ env: { CODEX_THREAD_ID: 't1' }, computer: 'mac', computerName: 'Studio', model: 'gpt-6.1-sol' });
  assert.deepEqual([codex.app, codex.model, codex.provider, codex.computer, codex.ai_id], ['Codex', 'gpt-6.1-sol', 'OpenAI', 'Studio', 'ai:codex-t1-on-mac']);
  assert.ok(!('name' in codex) && !('label' in codex), 'no name is made from the facts here');
  // The computer's own name, without the counter the system adds to a duplicate; a host name only when there is none.
  assert.equal(computerNameOf({ platform: 'darwin', exec: () => ({ status: 0, stdout: 'MacBook Pro (3)\n' }) }), 'MacBook Pro');
  assert.equal(computerNameOf({ platform: 'linux', exec: () => { throw new Error('not asked'); }, host: 'box.localdomain' }), 'box');
});

test('a task taken under the computer id before the upgrade is moved as that id', () => {
  const session = { ...me, agent_id: 'claude-code-7d2e6f4a9b10-on-mac', ai_id: 'ai:claude-code-7d2e6f4a9b10-on-mac', held_as: ['claude-code-on-mac'] };
  const call = (line, held) => argumentsFor(line[0], parseArgs(line.slice(1)), { me: session, held });
  const old = { 'claude-code-on-mac record:calendar-task:old': { said: '' } }, both = { ...old, 'claude-code-7d2e6f4a9b10-on-mac record:calendar-task:new': { said: 'Fix the build' } };
  assert.equal(call(['finish', 'record:calendar-task:old', 'done'], old).input.as, 'ai:claude-code-on-mac');
  assert.equal(call(['release', 'record:calendar-task:old'], old).input.as, 'ai:claude-code-on-mac');
  assert.equal(call(['stuck', 'record:calendar-task:old', 'a', 'sign-in'], old).input.as, 'ai:claude-code-on-mac');
  assert.equal(call(['finish', 'record:calendar-task:new', 'done'], both).input.as, session.ai_id);
  assert.equal(call(['finish', 'record:calendar-task:other', 'done'], both).input.as, session.ai_id, 'a task held nowhere here is this session\'s');
  assert.equal(call(['take'], both).input.as, session.ai_id, 'new work is always taken as this session');
  assert.deepEqual(holdingOf(session, { ...both, 'codex-on-mac record:calendar-task:x': { said: '' } }), [{ id: 'record:calendar-task:old', said: '' }, { id: 'record:calendar-task:new', said: 'Fix the build' }]);
});

test('this AI\'s record carries facts only: owner from the door, app, model, provider, computer, where it works and what it holds, never a name, path or secret', () => {
  const now = new Date('2026-11-02T08:00:00.000Z');
  const fresh = aiRecordOf(me, { account: ACCOUNT, now, repository: 'example', branch: 'main', holding: [] });
  assert.deepEqual(fresh, { ...settings.ai_record.new, owner: ACCOUNT, agent_id: me.agent_id, app: 'Claude Code', model: null, provider: 'Anthropic', computer: 'Mac', harness: 'Claude Code',
    where: 'repository example, branch main, in a terminal on this computer', working_on: null, live: { ...settings.ai_record.new.live, seen_at: now.toISOString() } });
  // What a person set on the record (a nickname, an order, what it can do) is kept as it is; the facts are made current.
  const kept = aiRecordOf(me, { account: ACCOUNT, now, held: { nickname: 'Builder', order: 2, can: ['code'], app: 'Old', label: 'take-open-work-preflight', live: { minutes: 10, seen_at: 'x' } },
    holding: [{ id: 'record:calendar-task:1', said: 'Review the login page' }] });
  assert.deepEqual([kept.nickname, kept.order, kept.can, kept.app, kept.live, kept.working_on], ['Builder', 2, ['code'], 'Claude Code', { how: 'heartbeat', minutes: 10, seen_at: now.toISOString() }, 'Review the login page']);
  assert.equal(aiRecordOf(me, { account: ACCOUNT, holding: [{ id: 'record:calendar-task:1', said: '' }, { id: 'record:calendar-task:2', said: '' }] }).working_on, 'record:calendar-task:2 (and 1 more)');
  assert.equal(aiRecordOf(me, { account: ACCOUNT, branch: null, repository: 'example' }).where, 'repository example, branch none (detached), in a terminal on this computer');
  assert.equal(aiRecordOf(me, { account: ACCOUNT }).where, 'a terminal on this computer');

  // git answers: the remote's last part only (its address may carry a sign-in), and the branch.
  const answers = { 'rev-parse': { status: 0, stdout: '/home/someone/dev/checkout-2\nfeature/cards\n' }, config: { status: 0, stdout: 'https://someone:user-428d77ea@example.com/Example-X/example.git\n' } };
  const exec = (command, args) => answers[args[0]];
  assert.deepEqual(placeOf({ exec }), { repository: 'example', branch: 'feature/cards' });
  answers.config = { status: 1, stdout: '' };
  assert.deepEqual(placeOf({ exec }), { repository: 'checkout-2', branch: 'feature/cards' }, 'no remote: the top folder\'s own name, not its path');
  answers['rev-parse'] = { status: 0, stdout: '/x/y\nHEAD\n' };
  assert.equal(placeOf({ exec }).branch, null);
  answers['rev-parse'] = { status: 128, stdout: '' };
  assert.deepEqual(placeOf({ exec }), {}, 'outside a repository nothing is said');

  const env = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: '5b1f0c2e-8a4d-4e3b-9c1a-7d2e6f4a9b10', EXAMPLE_KEY: KEY, HOME: '/home/someone', SECRET_TOKEN: 'sk_live_abc' };
  const record = JSON.stringify(aiRecordOf(agentOf({ env, computer: 'mac', model: null }), { account: ACCOUNT, repository: 'example', branch: 'main' }));
  for (const value of [KEY, '/home/someone', 'sk_live_abc', '5b1f0c2e-8a4d']) assert.ok(!record.includes(value), `the record does not carry ${value}`);
});

test('give says when the receiver sees the task', () => {
  assert.match(giveNote({ assignees: [] }), /^Anyone may take it\./);
  assert.equal(giveNote({ assignees: ['ai:codex-on-mac'] }), 'Assigned to ai:codex-on-mac: each sees it the next time it runs example tasks or example take, or at once while example serve runs for it.');
});

test('the key and the sign-in: a 0600 file off macOS, and on macOS the Keychain is written on standard input, never in an argument', () => {
  const folder = home();
  const file = keyStore({ home: folder, platform: 'linux' });
  assert.equal(file.read(), null);
  file.write(KEY);
  assert.equal(file.read(), KEY);
  assert.equal(statSync(join(folder, '.example/cli/key')).mode & 0o777, 0o600);
  file.forget();
  assert.equal(file.read(), null);
  assert.throws(() => file.write('not-a-key'), /not a key this command takes/);

  const asked = [];
  const exec = (command, args, options) => { asked.push({ command, args, input: options.input }); return { status: 0, stdout: `${KEY}\n` }; };
  const keychain = keyStore({ platform: 'darwin', exec });
  assert.equal(keychain.read(), KEY);
  keychain.write(KEY);
  assert.ok(asked.every(call => !call.args.join(' ').includes(KEY)), 'no argument carries the key');
  assert.match(asked[1].input, new RegExp(`^add-generic-password -U -a example -s ${settings.keychain_item} -w ${KEY}\\n$`));

  const grant = { access_token: 'access-1', refresh_token: 'refresh-1', expires_at_ms: 5, client_id: 'c1', origin: 'https://example.test' };
  const signIns = grantStore({ home: folder, platform: 'linux' });
  assert.equal(signIns.read(), null);
  signIns.write(grant);
  assert.deepEqual(signIns.read(), grant);
  assert.equal(statSync(join(folder, '.example/cli', settings.grant.file)).mode & 0o777, 0o600);
  signIns.forget();
  assert.equal(signIns.read(), null);
  const kept = [];
  const keychainSignIns = grantStore({ platform: 'darwin', exec: (command, args, options) => { kept.push({ args, input: options.input }); return { status: 0, stdout: kept.find(call => call.input)?.input.split(' -w ')[1] ?? '' }; } });
  keychainSignIns.write(grant);
  assert.deepEqual(keychainSignIns.read(), grant);
  assert.ok(kept.every(call => !call.args.join(' ').includes('access-1') && !call.args.join(' ').includes('refresh-1')), 'no argument carries the sign-in');
  assert.ok(kept[0].args.includes('-i') && kept[0].input.includes(settings.grant.keychain_item));
});

test('the credential: EXAMPLE_KEY, the kept key, else the kept sign-in, renewed before it ends', async () => {
  const store = { read: () => null, where: 'k' };
  assert.equal((await credentialFor({ env: { EXAMPLE_KEY: KEY }, store, grants: noGrants })).bearer, KEY);
  assert.equal(await credentialFor({ env: {}, store, grants: noGrants }), null);
  let written = null;
  const fake = await fakeDoor({ oauth: (url, raw, request, send) => {
    const asked = new URLSearchParams(raw);
    if (asked.get('grant_type') === 'refresh_token' && asked.get('refresh_token') === 'refresh-1') return send(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 });
    return send(400, { error: 'invalid_grant' });
  } });
  try {
    const grants = { where: 'g', read: () => ({ access_token: 'access-1', refresh_token: 'refresh-1', expires_at_ms: 1000, client_id: 'c1', origin: fake.origin, token_endpoint: `${fake.origin}/api/auth/oauth2/token`, resource: `${fake.origin}/mcp` }), write: grant => { written = grant; }, forget: () => {} };
    const renewed = await credentialFor({ env: {}, store, grants, now: () => 990, home: home() });
    assert.deepEqual([renewed.kind, renewed.bearer, renewed.origin, written.refresh_token], ['sign-in', 'access-2', fake.origin, 'refresh-2']);
    const ended = { ...grants, read: () => ({ access_token: 'a', refresh_token: 'gone', expires_at_ms: 1, client_id: 'c1', origin: fake.origin, token_endpoint: `${fake.origin}/api/auth/oauth2/token`, resource: `${fake.origin}/mcp` }) };
    await assert.rejects(credentialFor({ env: {}, store, grants: ended, now: () => 990, home: home() }), error => error.status === 3 && /sign-in to Example ended/.test(error.message));
  } finally { await fake.close(); }
});

test('the door: this computer\'s own door for the key when it has one, else the declared address; an asked origin wins', () => {
  const local = 'http://127.0.0.1:8788/mcp';
  const atHome = doorFor({ credential: keyCredential, localMcp: local });
  assert.deepEqual([atHome.mcp, atHome.local, atHome.name], [local, true, settings.words.local_door]);
  const away = doorFor({ credential: keyCredential, localMcp: null, declared: 'https://app.example.com' });
  assert.deepEqual([away.mcp, away.public], ['https://app.example.com/mcp', true]);
  assert.equal(doorFor({ credential: keyCredential, localMcp: null, declared: 'https://site.example' }).mcp, 'https://site.example/mcp', 'with no address named and no engine here, the sign-in site\'s own engine');
  assert.throws(() => doorFor({ credential: keyCredential, localMcp: null }), error => error.status === 2 && error.message === settings.words.no_origin, 'no address of Example\'s is kept in this shared tool');
  const pass = resource => ({ kind: 'sign-in', bearer: 'a', origin: 'https://issuer.test', resource });
  assert.equal(doorFor({ credential: pass('https://other.test/mcp'), localMcp: local }).mcp, 'https://other.test/mcp', 'a sign-in goes to the engine its pass was made for');
  assert.deepEqual([doorFor({ credential: pass(local), localMcp: local }).local, doorFor({ credential: pass('https://other.test/mcp'), localMcp: local }).local], [true, false]);
  assert.equal(doorFor({ asked: 'https://asked.test', credential: pass(local), localMcp: local }).mcp, 'https://asked.test/mcp', 'an address asked for names another engine');
  assert.equal(doorFor({ asked: 'http://127.0.0.1:9', credential: keyCredential, localMcp: local }).mcp, 'http://127.0.0.1:9/mcp');
});

test('the engine road sends a request key over the engine bound as its identity, the same on every retry, and a short key unchanged', async () => {
  let busy = 1;
  const fake = await fakeDoor({ sse: true, ops: { '@tools tools:run': () => (busy-- > 0 ? { status: 503 } : { changed: 1 }) } });
  try {
    const client = engineClient({ door: doorAt(fake.mcp), credential: keyCredential, rules: quick, wait: noWait });
    const long = 'replay-from-transcripts-' + 'x'.repeat(260);
    await client.op('@tools', 'tools:run', { tool: 'tool:x', input: {} }, { idempotent: true, requestKey: long });
    await client.op('@tools', 'tools:run', { tool: 'tool:x', input: {} }, { idempotent: true, requestKey: 'short-key-1' });
    const keys = fake.calls.filter(call => call.method === 'tools:run').map(call => call.request_key);
    assert.equal(keys.length, 3, 'one refused attempt, then the retry, then the short key');
    assert.match(keys[0], /^key:1f:[0-9a-f]{64}$/);
    assert.equal(keys[0], keys[1], 'a retry of the long key carries the same identity');
    assert.notEqual(keys[0], long);
    assert.equal(keys[2], 'short-key-1', 'a key within the bound is sent unchanged');
  } finally {
    await fake.close();
  }
});

test('the engine road: replies in JSON or events, one request key on every retry, refusals that name the door and never say log in', async () => {
  assert.deepEqual(repliesOf('event: message\ndata: {"id":1}\n\n'), [{ id: 1 }]);
  let busy = 2;
  const fake = await fakeDoor({ sse: true, ops: {
    '@tools tools:list': () => (busy-- > 0 ? { status: 503 } : { tools: [] }),
    '@tools tools:run': () => ({ refused: 'That tool is not offered here.' }),
  } });
  try {
    const client = engineClient({ door: doorAt(fake.mcp), credential: keyCredential, rules: quick, wait: noWait });
    assert.deepEqual(await client.op('@tools', 'tools:list', {}, { idempotent: true }), { tools: [] });
    const keys = fake.calls.filter(call => call.method === 'tools:list').map(call => call.request_key);
    assert.equal(keys.length, 3);
    assert.equal(new Set(keys).size, 1, 'a retry carries the same request key');
    await assert.rejects(client.op('@tools', 'tools:run', { tool: 'tool:x', input: {} }), /not offered here/);
    // A refused key: the door says which door; at the public door it names this computer's local door.
    const refusedAt = (door, credential = { kind: 'key', bearer: `nm_${'cd'.repeat(32)}`, where: 'k' }) => engineClient({ door, credential, rules: quick, wait: noWait }).whoami();
    await assert.rejects(refusedAt(doorAt(fake.mcp)), error => error.status === 3 && error.message === settings.words.refused && error.detail === `${fake.mcp} answered 401 to this key, kept in k.`);
    await assert.rejects(refusedAt(doorAt(fake.mcp, { public: true, name: `the public door ${fake.mcp}`, localMcp: 'http://127.0.0.1:8788/mcp' })),
      error => error.message === settings.words.refused_key_at_door && !/127\.0\.0\.1|8788/.test(error.message));
    // A route the door does not serve.
    const missing = engineClient({ door: doorAt(`${fake.origin}/mcp/api/account`), credential: keyCredential, rules: quick, wait: noWait });
    await assert.rejects(missing.whoami(), error => error.message === `the door ${fake.origin}/mcp/api/account does not have what this needs. Update Example, then try again.` && error.detail === `${fake.origin}/mcp/api/account answered 404 for /mcp/api/account.` && !/log ?in/i.test(error.message));
    assert.throws(() => engineClient({ door: doorAt(fake.mcp), credential: null }), error => error.status === 3 && /Run example login/.test(error.message));
  } finally { await fake.close(); }
  const gone = engineClient({ door: doorAt('http://127.0.0.1:9/mcp'), credential: keyCredential, rules: { ...quick, retry: { ...quick.retry, count: 0 } }, wait: noWait });
  await assert.rejects(gone.whoami(), error => error.status === 4 && /could not be reached/.test(error.message) && /127\.0\.0\.1:9\/mcp could not be reached/.test(error.detail) && !/log ?in/i.test(error.message));
});

test('whoami: the account from MCP initialize, this AI\'s id and facts, and the door that answered', async () => {
  const fake = await fakeDoor();
  try {
    const seams = seamsFor(home(), { localDoor: () => fake.mcp });
    const said = await main(['whoami'], seams);
    assert.equal(said, ["You're signed in to Example.", 'Example at: this computer', `AI: ai:claude-code-on-${computerOf()}`, 'Running on: Claude Code, Anthropic, Mac'].join('\n'));
    assert.equal(await main(['whoami', '--verbose'], seams), [said, `account ${ACCOUNT}`, `door ${fake.mcp}`].join('\n'), 'the account id and the address are said only with --verbose');
    const json = JSON.parse(await main(['whoami', '--json'], seams));
    assert.deepEqual([json.account_id, json.local, json.door, json.app, json.computer], [ACCOUNT, true, fake.mcp, 'Claude Code', 'Mac']);
    assert.ok(!JSON.stringify(json).includes(KEY));
  } finally { await fake.close(); }
});

test('tools: every page of the Workshop list until next is null, and a pager that repeats a page is refused', async () => {
  const pages = { '': { tools: [{ id: 'tool:a', job: 'Does a' }], next: 'p2' }, p2: { tools: [{ id: 'tool:b', job: 'Does b' }], next: 'p3' }, p3: { tools: [{ id: 'tool:c', job: 'Does c' }], next: null } };
  const fake = await fakeDoor({ ops: {
    '@tools tools:list': input => pages[input.after ?? ''],
    '@tools tools:run': input => ({ ran: input.tool, with: input.input }),
  } });
  try {
    const seams = seamsFor(home(), { localDoor: () => fake.mcp });
    assert.equal(await main(['tools'], seams), 'tool:a  Does a\ntool:b  Does b\ntool:c  Does c');
    assert.deepEqual(fake.calls.filter(call => call.method === 'tools:list').map(call => call.input), [{}, { after: 'p2' }, { after: 'p3' }]);
    assert.deepEqual(JSON.parse(await main(['call', 'tool:b', '{"x":1}'], seams)), { ran: 'tool:b', with: { x: 1 } });
    await assert.rejects(main(['call', 'tool:b', '[1]'], seams), /one JSON object/);
    const stuck = { op: async () => ({ tools: [{ id: 'tool:a' }], next: 'same' }) };
    await assert.rejects(allPages(stuck, '@tools', 'tools:list', {}, 'tools'), error => error.message === settings.words.pager_stuck && /answered the page after same again/.test(error.detail));
  } finally { await fake.close(); }
});

// The person's `ai_list` list, whose title field is a formula field (the binding is the engine's; the stand-in below
// answers what it would).
const AI_LIST = { id: 'list:ais', type: 'list', value: { label: 'Your AIs', row_type: 'ai', title_field: 'name', fields: [
  { id: 'name', kind: 'formula', label: 'Name', derive: { request: { binding: { $kind: 'binding', select: { from: 'self', path: [] } } } } }, { id: 'nickname', kind: 'text', label: 'Nickname' }] } };
const nameOf = value => value.nickname ?? [value.app, value.model, value.computer].filter(Boolean).join(' · ');
// tools:run as the engine answers it: the tool's own answer under `result`.
const ran = result => ({ exit_code: 0, replayed: false, result });

test('who: the AIs tool:see-who-can-take-work answers, named by the list:ais formula handed in, in one call, grouped by owner with yours first, ready chats beneath, the rest counted', async () => {
  const now = Date.now();
  const recent = new Date(now - 10 * 60_000).toISOString(), earlier = new Date(now - 5 * 3_600_000).toISOString(), old = new Date(now - 10 * 86_400_000).toISOString();
  const codex = { app: 'Codex', model: 'gpt-6.1-sol', computer: 'Studio' };
  const ais = [
    { id: 'ai:codex-1-on-mac', value: { agent_id: 'codex-1-on-mac', ...codex, working_on: 'Review the login page' }, live: true, seen_at: recent, busy: 1 },
    { id: 'ai:sofus', value: { agent_id: 'claude-x', owner: '1234567890abcdef', nickname: 'Sofus\'s research Claude', app: 'Claude Code' }, live: true, seen_at: recent, busy: 0 },
    { id: 'ai:codex-2-on-mac', value: { agent_id: 'codex-2-on-mac', ...codex }, live: false, seen_at: earlier, busy: 0 },
    { id: 'ai:old', value: { agent_id: 'take-open-work-preflight', label: 'take-open-work-preflight', kind: 'account' }, live: false, seen_at: old, busy: 0 },
  ];
  const fake = await fakeDoor({ ops: {
    '@own-records records:list': () => ({ records: [], next: null }),
    '@tools tools:run': input => (input.tool === 'tool:see-who-can-take-work' ? ran({ who: ais })
      : input.tool === 'tool:evaluate-a-formula' ? ran({ values: input.input.rows.map(row => nameOf(row) || null), errors: [] }) : { refused: `no ${input.tool}` }),
  } });
  try {
    const seams = seamsFor(home(), { localDoor: () => fake.mcp });
    const folder = home(), listFile = join(folder, 'list.json');
    writeFileSync(listFile, JSON.stringify(AI_LIST.value));
    const who = (await main(['who', '--list', listFile], seams)).split('\n');
    assert.equal(who[0], `Yours (account ${ACCOUNT.slice(0, 8)}…)`);
    assert.match(who[1], /^ {2}Codex · gpt-6\.1-sol · Studio {2}1 of 2 chats ready {2}last seen .+$/);
    assert.equal(who[2], '    ready  ai:codex-1-on-mac  1 taken  working on: Review the login page');
    assert.equal(who[3], 'Account 12345678…', 'another person\'s AI always shows its owner');
    assert.match(who[4], /^ {2}Sofus's research Claude {2}1 of 1 chats ready/, 'a nickname is the AI\'s name');
    assert.equal(who[5], '    ready  ai:sofus');
    assert.equal(who[6], '1 more chats not seen in 3 days; example who --all shows them.');
    assert.equal(who.length, 7, 'one line per AI, not one per chat; away chats are counted in their AI\'s line');
    const formulaCalls = fake.calls.filter(call => call.input?.tool === 'tool:evaluate-a-formula');
    assert.equal(formulaCalls.length, 1, 'the names are worked out in one call');
    assert.deepEqual(formulaCalls[0].input.input.binding, AI_LIST.value.fields[0].derive.request.binding, 'the list\'s own formula, as it is stored');
    assert.equal(formulaCalls[0].input.input.rows.length, 3, 'only the AIs shown are named');
    const all = await main(['who', '--all', '--list', listFile], seams);
    assert.match(all, /An AI with no app, model or computer recorded \(account\) {2}0 of 1 chats ready/);
    assert.match(all, / {4}away {2}ai:codex-2-on-mac {2}last seen /);
    assert.ok(!all.includes('take-open-work-preflight'), 'an AI\'s own label is never its name');
    const groups = groupsOf(ais.map(row => aiOf(row, { name: nameOf(row.value), now, owner: ACCOUNT })), { you: ACCOUNT });
    assert.deepEqual(groups.map(group => [group.owner, group.mine, group.ais.map(ai => ai.chats.length)]), [[ACCOUNT, true, [2, 1]], ['1234567890abcdef', false, [1]]]);
    assert.equal(aiOf(ais[2], { now }).ready, false, 'liveness is the tool\'s, computed when read');
    assert.equal(render('who', { groups: [], hidden: 0 }), settings.who.none);
    // A list whose title is not a formula names nothing some other way: who says which list it needs.
    const notFormula = join(folder, 'not-formula.json');
    writeFileSync(notFormula, JSON.stringify({ ...AI_LIST.value, title_field: 'nickname' }));
    await assert.rejects(main(['who', '--list', notFormula], seams), error => error.status === 2 && error.message.includes('list:ais') && !/log ?in/i.test(error.message));
    // With no list given the AIs are shown unnamed, and no row is read from anywhere: only the work tool is called.
    const before = fake.calls.length;
    const unnamed = (await main(['who'], seams)).split('\n');
    assert.match(unnamed[1], /^ {2}An AI with no app, model or computer recorded/);
    assert.deepEqual(fake.calls.slice(before).filter(call => call.method === 'tools:run').map(call => call.input?.tool), ['tool:see-who-can-take-work'], 'only the task row is run; the records it needs are read and handed in');
    const client = engineClient({ door: doorAt(fake.mcp), credential: keyCredential, rules: quick, wait: noWait });
    assert.deepEqual(await namesOf(client, [], AI_LIST.value), [], 'no AI shown: nothing to name');
  } finally { await fake.close(); }
  // A Workshop without the work tool says which tool is missing, in plain words, never "log in".
  const bare = await fakeDoor({ ops: { '@own-records records:list': () => ({ records: [], next: null }), '@tools tools:run': () => ({ code: 'tools_tool_unknown' }) } });
  try {
    await assert.rejects(main(['who'], seamsFor(home(), { localDoor: () => bare.mcp })),
      error => error.code === 'tools_tool_unknown' && /^tool:see-who-can-take-work is not set up in your Example yet\./.test(error.message) && !/log ?in/i.test(error.message));
  } finally { await bare.close(); }
});

// The task rows over an in-memory account: each command reads what its move needs and applies only the writes the row answers.
const taskOf = (id, value = {}) => [id, 'calendar-task', { title: 'Fix the build', status: 'To do', sent_by: 'ai:claude-code-on-mac', sent_at: '2026-11-19T12:00:00.000Z', priority: 'medium', ...value }];

test('give → take → hand-on to person:someone → that person takes and finishes: every write goes through records:write with expected, and a task another AI took first is shown, never retried', async () => {
  const store = recordStore([['ai:codex-on-mac', 'ai', { agent_id: 'codex-on-mac' }], ['build:main', 'build', { status: 'green' }]]);
  const ops = taskDoorOps(store);
  const writeOf = ops['@own-records records:write'];
  let takenByPeer = null;
  ops['@own-records records:write'] = input => {
    // The peer's take lands between this take's read and its write, so the write is refused whole.
    if (takenByPeer) { store.put(takenByPeer, 'calendar-task', { ...store.get(takenByPeer), status: 'In progress', taken_by: 'ai:codex-on-mac', taken_at: '2026-11-19T12:30:00.000Z' }); takenByPeer = null; }
    return writeOf(input);
  };
  const fake = await fakeDoor({ ops });
  try {
    const folder = home();
    const seams = (extra = {}) => seamsFor(folder, { localDoor: () => fake.mcp, ...extra });
    const acceptance = join(home(), 'acceptance.json');
    writeFileSync(acceptance, JSON.stringify({ outcome: 'The build is green', target: { type: 'build', id: 'build:main' }, rules: [{ id: 'outcome', path: 'status', equals: ['green'] }] }));
    const given = await main(['give', 'Fix', 'the', 'build', '--key', 'k1', '--acceptance-file', acceptance], seams());
    assert.match(given, /^Gave record:calendar-task:k1\.\nrecord:calendar-task:k1 {2}To do {2}for anyone {2}from ai:claude-code-on-/);
    assert.equal(store.get('record:calendar-task:k1').status, 'To do', 'the task is written once, waiting');
    assert.match(await main(['take'], seams()), /^Took record:calendar-task:k1\./);
    assert.equal(store.get('record:calendar-task:k1').taken_by, `ai:claude-code-on-${computerOf()}`);
    assert.deepEqual(Object.keys(seams().state.held()), [`claude-code-on-${computerOf()} record:calendar-task:k1`], 'the task taken is held here');
    store.put('person:someone', 'person', { name: 'Someone' });
    assert.match(await main(['hand-on', 'record:calendar-task:k1', '--to', 'person:someone', '--because', 'Yours now'], seams()), /^record:calendar-task:k1: In progress -> To do\./);
    assert.deepEqual(store.get('record:calendar-task:k1').assignees, ['person:someone']);
    assert.deepEqual(seams().state.held(), {}, 'a task handed on is no longer held by the AI that handed it');
    assert.match(await main(['take', 'record:calendar-task:k1', '--as', 'person:someone'], seams()), /^Took record:calendar-task:k1\./, 'the person it was handed to takes it');
    const checked = join(home(), 'check.json');
    writeFileSync(checked, JSON.stringify({ outcome: 'The build is green', checked_at: new Date().toISOString(), evidence: [{ ref: 'build:main', observation: 'status is green' }], obligations: [] }));
    assert.match(await main(['finish', 'record:calendar-task:k1', 'Built.', '--check-file', checked, '--as', 'person:someone'], seams()), /^record:calendar-task:k1: In progress -> Done\./);
    assert.equal(store.get('record:calendar-task:k1').status, 'Done');
    assert.equal(store.get('record:calendar-task:k1').result, 'Built.');
    const sentWithWait = await main(['give', 'x', '--key', 'k2', '--wait', '5'], seams({ wait: async () => store.put('record:calendar-task:k2', 'calendar-task', { ...store.get('record:calendar-task:k2'), status: 'Done', result: 'Built.' }) }));
    assert.match(sentWithWait, /^record:calendar-task:k2 {2}Done/, '--wait reads the task until it is in a state the rows end in');

    // Another AI takes the next task between this take's read and its write: the write is refused whole, and the take says who did.
    store.put('record:calendar-task:k3', 'calendar-task', taskOf('record:calendar-task:k3')[2]);
    takenByPeer = 'record:calendar-task:k3';
    assert.match(await main(['take', 'record:calendar-task:k3'], seams()), /^Another AI \(ai:codex-on-mac\) moved record:calendar-task:k3 first\.\nrecord:calendar-task:k3 {2}In progress {2}taken by ai:codex-on-mac/, 'a task taken by another AI is shown, never tried again');
    const writes = fake.calls.filter(call => call.method === 'records:write');
    assert.ok(writes.length >= 5, 'every move wrote its records through records:write');
    assert.ok(writes.every(call => call.input.records.every(record => 'expected' in record)), 'every write is conditioned on the value it was read at');
    assert.ok(fake.calls.filter(call => call.method === 'tools:run').every(call => Array.isArray(call.input.input.records)), 'every task row is handed the records it reads');
  } finally { await fake.close(); }
});

test('a move another AI made between its read and its write is reported as changed, and nothing is written over it', async () => {
  const store = recordStore([['ai:claude-code-on-mac', 'ai', {}], ['record:calendar-task:r', 'calendar-task', { title: 'Race', status: 'In progress', taken_by: 'ai:claude-code-on-mac', taken_at: '2026-11-19T12:00:00.000Z', sent_by: 'ai:codex-on-mac', sent_at: '2026-11-19T11:00:00.000Z', priority: 'medium' }]]);
  const ops = taskDoorOps(store);
  const writeOnce = ops['@own-records records:write'];
  let raced = false;
  ops['@own-records records:write'] = input => {
    if (!raced) { raced = true; store.put('record:calendar-task:r', 'calendar-task', { ...store.get('record:calendar-task:r'), description: 'Changed by a peer' }); }
    return writeOnce(input);
  };
  const fake = await fakeDoor({ ops });
  try {
    const seams = seamsFor(home(), { localDoor: () => fake.mcp });
    assert.match(await main(['stuck', 'record:calendar-task:r', 'waiting', 'on', 'access'], seams), /^record:calendar-task:r was not moved \(changed\)/);
    assert.equal(store.get('record:calendar-task:r').description, 'Changed by a peer', 'the peer\'s write is kept; this move wrote nothing over it');
    assert.equal(store.get('record:calendar-task:r').stuck, undefined);
  } finally { await fake.close(); }
});

test('a move names the claim read from the task\'s own row when this AI holds it: an AI that does not hold a task is refused, saying who holds it', async () => {
  const store = recordStore([
    ['record:calendar-task:lane-a', 'calendar-task', { title: 'Lane a', outcome: 'Lane a', status: 'In progress', taken_by: 'ai:lane-a', taken_at: '2026-11-15T20:00:00.000Z', sent_by: 'ai:lane-c', sent_at: '2026-11-15T19:00:00.000Z', priority: 'medium',
      acceptance: { outcome: 'Lane a', target: { type: 'note', id: 'note:lane-a' }, rules: [{ id: 'outcome', path: 'text', equals: ['Lane a'] }] } }],
    ['record:calendar-task:lane-b', 'calendar-task', { title: 'Lane b', status: 'In progress', taken_by: 'ai:lane-b', taken_at: new Date().toISOString(), sent_by: 'ai:lane-c', sent_at: '2026-11-15T19:00:00.000Z', priority: 'medium' }],
    ['note:lane-a', 'note', { text: 'Lane a' }],
  ]);
  const fake = await fakeDoor({ ops: taskDoorOps(store) });
  try {
    const folder = home();
    const seams = () => seamsFor(folder, { localDoor: () => fake.mcp });
    // Both tasks are held here under old claims: the shared file's memory is wrong for both lanes.
    seamsFor(folder).state.hold('lane-a', { id: 'record:calendar-task:lane-a', title: 'x', taken_at: '2026-11-14T01:00:00.000Z' });
    seamsFor(folder).state.hold('lane-b', { id: 'record:calendar-task:lane-b', title: 'x', taken_at: '2026-11-14T02:00:00.000Z' });
    const checkFile = join(home(), 'check.json');
    writeFileSync(checkFile, JSON.stringify({ outcome: 'Lane a', checked_at: '2026-11-15T20:05:00.000Z', evidence: [{ ref: 'note:lane-a', observation: 'Read back.' }], obligations: [] }));
    assert.match(await main(['finish', 'record:calendar-task:lane-a', 'Done a.', '--check-file', checkFile, '--as', 'lane-a'], seams()), /: In progress -> Done\./, 'lane a finishes the task its row holds, under its own claim');
    assert.equal(store.get('record:calendar-task:lane-a').status, 'Done');
    assert.match(await main(['release', 'record:calendar-task:lane-b', '--because', 'Not mine.', '--as', 'lane-b'], seams()), /: In progress -> To do\./, 'lane b releases its own task');
    store.put('record:calendar-task:lane-c', 'calendar-task', { title: 'Lane c', status: 'In progress', taken_by: 'ai:lane-b', taken_at: new Date().toISOString(), sent_by: 'ai:lane-c', sent_at: '2026-11-15T19:00:00.000Z', priority: 'medium' });
    await assert.rejects(main(['release', 'record:calendar-task:lane-c', '--because', 'Not mine.', '--as', 'lane-a'], seams()), /does not hold for ai:lane-a \(the task is taken by ai:lane-b/, 'an AI that does not hold a recent task is refused, saying who holds it');
  } finally { await fake.close(); }
});

test('publish: this AI\'s own record as one keep row, conditioned on the value handed in, and nothing is read or written', async () => {
  const stored = { nickname: 'Builder', order: 3, app: 'Old app', live: { minutes: 30 } };
  const fake = await fakeDoor({ ops: {} });
  try {
    const seams = seamsFor(home(), { localDoor: () => fake.mcp });
    const fresh = JSON.parse(await main(['publish'], seams));
    assert.equal(fresh.keep.length, 1);
    assert.deepEqual([fresh.keep[0].id, fresh.keep[0].type, fresh.keep[0].expected, fresh.keep[0].value.owner], [`ai:claude-code-on-${computerOf()}`, 'ai', null, ACCOUNT],
      'a new record is kept on condition it is absent, its owner the door\'s account');
    const over = JSON.parse(await main(['publish', JSON.stringify(stored)], seams)).keep[0];
    assert.deepEqual([over.value.nickname, over.value.order, over.value.app], ['Builder', 3, 'Claude Code'], 'the person\'s own cells are carried, the facts are set');
    assert.deepEqual(over.expected, { type: 'ai', value: stored }, 'the keep is conditioned on the value handed in');
    assert.deepEqual(fake.calls.map(call => call.method).filter(method => method !== 'initialize'), [], 'no operation is sent: only who the door answers for');
    await assert.rejects(main(['publish', '[1]'], seams), /one JSON object/);
  } finally { await fake.close(); }
  const context = { me, placeImpl: () => ({}), state: { held: () => ({ [`${me.agent_id} record:calendar-task:1`]: { said: 'Fix the build' } }) } };
  const client = { whoami: async () => ({ account: ACCOUNT }), op: async () => { throw new Error('nothing is sent'); } };
  const { keep } = await publishRecord(client, context, { held: null });
  assert.equal(keep[0].id, me.ai_id);
  assert.deepEqual(keep[0].value.working_on, 'Fix the build', 'a held task is what the record says it works on');
});

test('serve: a task taken is run, then finished, blocked on a next step when it cannot be checked or fails, or said stuck, each by its task row', async () => {
  const calls = [];
  const acceptance = { outcome: 'Said hi', target: { type: 'note', id: 'note:1' }, rules: [{ id: 'outcome', path: 'text', equals: ['Said hi'] }] };
  const scenarios = [
    { name: 'finished', value: { outcome: 'Said hi', acceptance }, result: { ok: true, output: 'hi', check: true }, action: 'finish', status: 'Done', held: [['hold', task], ['let go', task]] },
    { name: 'no receipt', value: { outcome: 'Said hi', acceptance }, result: { ok: true, output: 'hi' }, action: 'wait', status: 'Waiting', held: [['hold', task], ['let go', task]] },
    { name: 'no acceptance', value: { outcome: 'Said hi' }, result: { ok: true, output: 'hi', check: true }, action: 'wait', status: 'Waiting', held: [['hold', task], ['let go', task]] },
    { name: 'failed', value: { outcome: 'Said hi', acceptance }, result: { ok: false, output: 'failed' }, action: 'wait', status: 'Waiting', held: [['hold', task], ['let go', task]] },
    { name: 'stuck', value: { outcome: 'Said hi', acceptance }, result: { ok: true, output: 'x', stuck: 'Which bank?' }, action: 'stuck', status: 'In progress', held: [['hold', task]] },
  ];
  for (const scenario of scenarios) {
    const store = recordStore([['ai:claude-code-on-mac', 'ai', {}], ['note:1', 'note', { text: 'Said hi' }], taskOf('record:calendar-task:1', scenario.value)]);
    const ops = taskDoorOps(store);
    const client = { wait: noWait, op: async (address, method, input) => {
      calls.push({ address, method, tool: input?.tool, action: input?.input?.action });
      const handler = ops[`${address ?? (method.startsWith('tools:') ? '@tools' : '')} ${method}`];
      const answer = await handler(input, { address, method });
      if (answer?.refused) throw new Error(answer.refused);
      return answer;
    } };
    const held = [];
    const state = { hold: (agent, task) => held.push(['hold', task.id]), letGo: (agent, id) => held.push(['let go', id]) };
    calls.length = 0;
    const runImpl = async () => (scenario.result.check ? { ...scenario.result, check: { outcome: 'Said hi', checked_at: new Date().toISOString(), evidence: [{ ref: 'note:1', observation: 'Read back.' }], obligations: [] } } : scenario.result);
    assert.equal(await serveOnce({ client, me, command: ['cat'], state, log: () => {}, runImpl }), true, scenario.name);
    assert.ok(calls.some(call => call.tool === settings.tasks.tools.take), `${scenario.name}: the task is taken by its take row`);
    const moved = calls.find(call => call.action === scenario.action || (scenario.action === 'finish' && call.tool === settings.tasks.tools.finish));
    assert.ok(moved, `${scenario.name}: the move is made by its row`);
    assert.equal(store.get('record:calendar-task:1').status, scenario.status, scenario.name);
    if (scenario.action === 'wait' && scenario.value.acceptance) assert.equal(store.get('record:calendar-task:1').continuation.owner, me.ai_id, 'a run that cannot finish is blocked on a next step this AI owns');
    if (scenario.action === 'stuck') assert.deepEqual([store.get('record:calendar-task:1').stuck.words, store.get('record:calendar-task:1').stuck.by], ['Which bank?', me.ai_id], 'a stuck task says what is in the way, and who said it');
    assert.deepEqual(held, scenario.held, `${scenario.name}: the hold`);
  }
  const none = { wait: noWait, op: async (address, method) => (method === 'records:list' ? { records: [], next: null } : null) };
  assert.equal(await serveOnce({ client: none, me, command: ['cat'], state: { hold: () => {}, letGo: () => {} }, log: () => {} }), false);
  assert.equal(await waitFor(async () => 'found', { seconds: 1, sleep: noWait }), 'found');
  assert.equal(await waitFor(async () => null, { seconds: 0, sleep: noWait }), null);
  const workClient = { op: async (address, method, input, options) => ({ address, method, input, options }) };
  const bare = await toolCall(workClient, settings.tasks.tools.see, { id: task }, { idempotent: true });
  assert.match(bare.options.requestKey, /^[0-9a-f-]{36}$/, 'the call has one key, which any further page of its answer is asked under');
  assert.deepEqual({ ...bare, options: { idempotent: bare.options.idempotent } },
    { address: null, method: 'tools:run', input: { tool: 'tool:see-tasks', input: { id: task } }, options: { idempotent: true } }, 'an answer with no result is the answer itself');
});

test('login: the browser sign-in with PKCE keeps the sign-in itself, and no key route is asked', async () => {
  const seen = {};
  let challenge = null;
  const pass = 'x.y.z';
  const fake = await fakeDoor({ bearers: [KEY, pass],
    oauth: (url, raw, request, send) => {
      seen.paths = [...(seen.paths ?? []), url.pathname];
      const at = path => `http://${request.headers.host}${path}`;
      if (url.pathname === '/.well-known/oauth-authorization-server') return send(200, { authorization_endpoint: at('/api/auth/oauth2/authorize'), token_endpoint: at('/api/auth/oauth2/token'), revocation_endpoint: at('/api/auth/oauth2/revoke') });
      if (url.pathname === settings.protected_resource_path) return send(200, { resource: at('/mcp'), authorization_servers: [at('')] });
      const asked = new URLSearchParams(raw);
      if (asked.get('grant_type') === 'authorization_code') {
        seen.verified = createHash('sha256').update(asked.get('code_verifier')).digest('base64url') === challenge && asked.get('code') === 'code-1';
        return send(200, { access_token: pass, refresh_token: 'refresh-1', expires_in: 3600 });
      }
      if (asked.get('token_type_hint') === 'refresh_token') { seen.revoked = asked.get('token'); return send(200, {}); }
      return send(400, { error: 'unexpected' });
    } });
  try {
    const open = async url => {
      const asked = new URL(url);
      challenge = asked.searchParams.get('code_challenge');
      seen.authorize = Object.fromEntries(asked.searchParams);
      const back = await fetch(`${asked.searchParams.get('redirect_uri')}?code=code-1&state=${asked.searchParams.get('state')}`, { redirect: 'manual' });
      seen.page = { status: back.status, location: back.headers.get('location') };
    };
    const grant = await signInWithBrowser({ origin: fake.origin, open, now: () => 1000 });
    assert.deepEqual(grant, { access_token: pass, refresh_token: 'refresh-1', expires_at_ms: 1000 + 3600_000, client_id: `${fake.origin}${settings.client.id_path}`, origin: fake.origin, token_endpoint: `${fake.origin}/api/auth/oauth2/token`, revocation_endpoint: `${fake.origin}/api/auth/oauth2/revoke`, resource: `${fake.origin}/mcp`, asked: settings.scope });
    assert.equal(seen.verified, true, 'the code was exchanged with the verifier that matches the challenge');
    assert.equal(seen.authorize.code_challenge_method, 'S256');
    assert.equal(seen.authorize.scope, settings.scope);
    assert.equal(seen.authorize.resource, `${fake.origin}/mcp`);
    assert.equal(seen.authorize.client_id, `${fake.origin}${settings.client.id_path}`);
    assert.equal(seen.authorize.redirect_uri, `http://127.0.0.1:${settings.client.redirect_port}/callback`);
    assert.deepEqual(JSON.parse(readFileSync(new URL('../do-work/client-metadata.json', import.meta.url), 'utf8').replaceAll('{origin}', fake.origin)).redirect_uris, [seen.authorize.redirect_uri], 'the client document lists the redirect the program uses');
    assert.equal(seen.page.status, 302);
    assert.equal(seen.page.location, `${fake.origin}/sign-in/done?result=done`, 'the browser is sent to the sign-in tool\'s own page');
    assert.ok(seen.paths.every(path => !path.includes('/mcp/api')), 'no key route is asked');

    // Through the command: no key here, so login keeps the sign-in, and the public origin answers as that account.
    const folder = home();
    let kept = null;
    const grants = { where: 'test sign-in', read: () => kept, write: value => { kept = value; }, forget: () => { kept = null; } };
    const state = stateOf({ home: folder });
    const run = argv => main([...argv, '--origin', fake.origin], { store: { read: () => null, where: 'no key' }, grants, state, open, env: {}, agentSocket: () => null, localDoor: () => null, computerName: 'Mac', model: null, wait: noWait });
    assert.equal(await run(['login']), "You're signed in to Example.");
    assert.equal(await run(['login']), "You're signed in to Example.", 'signed in already is the same one line');
    assert.equal(await run(['logout']), "You're signed out of Example.");
    assert.equal(seen.revoked, 'refresh-1');
    assert.equal(kept, null);
    assert.equal(await run(['logout']), settings.words.not_signed_in);
    const pair = pkce();
    assert.equal(createHash('sha256').update(pair.verifier).digest('base64url'), pair.challenge);
  } finally { await fake.close(); }
});

test('login with no address signs in at the site this command was installed from; --origin names another; an engine that does not answer opens nothing; with no site it says how to install', async () => {
  const pass = passFor('person@example.com');
  const site = await fakeDoor({ bearers: [pass], oauth: signInServer(pass) });
  const named = await fakeDoor({ bearers: [pass], oauth: signInServer(pass) });
  const asked = [];
  // The site's address is the real one, so its requests are sent to the stand-in; any other address is asked as it is.
  const reroute = async (address, init) => { asked.push(String(address)); return fetch(String(address).replace('https://site.example', site.origin), init); };
  try {
    const opened = [];
    const grants = grantsKept(null);
    // The site this command was installed from: its install line wrote the site file.
    const state = stateOf({ home: home() });
    state.keepSite('https://site.example');
    const seams = { store: { read: () => null, where: 'none' }, grants, state, open: openAndReturn(opened), env: {}, agentSocket: () => null, localDoor: () => null, fetchImpl: reroute, computerName: 'Mac', model: null, wait: noWait };
    assert.equal(await main(['login'], seams), "You're signed in to Example as person@example.com.");
    assert.equal(asked[0], `https://site.example${settings.protected_resource_path}`, 'no address: the sign-in site\'s own engine');
    assert.equal(grants.box.value.resource, `${site.origin}/mcp`);
    assert.equal(opened.length, 1);
    assert.equal(await main(['login'], seams), "You're signed in to Example as person@example.com.", 'signed in already: nothing more');
    assert.equal(opened.length, 1);
    await main(['login', '--origin', named.origin], seams);
    assert.equal(grants.box.value.resource, `${named.origin}/mcp`, 'an address asked for gets its own sign-in');
    assert.equal(opened.length, 2);
    await assert.rejects(main(['login', '--origin', 'http://127.0.0.1:9'], seams), error => error.status === 4 && error.message === settings.words.not_answering);
    assert.equal(opened.length, 2, 'an engine that does not answer opens no browser and no other engine is used');
    const nowhere = { ...seams, grants: grantsKept(null), state: stateOf({ home: home() }) };
    await assert.rejects(main(['login'], nowhere), error => error.status === 2 && error.message === settings.words.no_origin && !/origin/.test(error.message), 'no site and no address: how to install, never an address to type');
    assert.equal(opened.length, 2);
  } finally { await site.close(); await named.close(); }
});

test('login: a kept key its door refuses is no sign-in, so login signs in at the browser, and the sign-in then comes before the key', async () => {
  const pass = 'x.y.z';
  const fake = await fakeDoor({ bearers: [pass],
    oauth: (url, raw, request, send) => {
      const at = path => `http://${request.headers.host}${path}`;
      if (url.pathname === '/.well-known/oauth-authorization-server') return send(200, { authorization_endpoint: at('/api/auth/oauth2/authorize'), token_endpoint: at('/api/auth/oauth2/token') });
      if (url.pathname === settings.protected_resource_path) return send(200, { resource: at('/mcp'), authorization_servers: [at('')] });
      return new URLSearchParams(raw).get('grant_type') === 'authorization_code' ? send(200, { access_token: pass, refresh_token: 'refresh-1', expires_in: 3600 }) : send(400, { error: 'unexpected' });
    } });
  try {
    let kept = null;
    const grants = { where: 'test sign-in', read: () => kept, write: value => { kept = value; }, forget: () => { kept = null; } };
    const store = { read: () => KEY, where: 'a kept key' };
    const open = async url => { const asked = new URL(url); await fetch(`${asked.searchParams.get('redirect_uri')}?code=code-1&state=${asked.searchParams.get('state')}`); };
    const said = await main(['login', '--origin', fake.origin], { store, grants, state: stateOf({ home: home() }), open, env: {}, agentSocket: () => fake.socket, localDoor: () => `${fake.origin}/mcp`, computerName: 'Mac', model: null, wait: noWait });
    assert.equal(said, "You're signed in to Example.");
    assert.deepEqual(fake.added, [`Bearer ${pass}`], 'the engine at the local door was asked to hold the person the pass names');
    assert.equal((await credentialFor({ env: {}, store, grants, fetchImpl: fetch })).kind, 'sign-in', 'the sign-in comes before the kept key');
  } finally { await fake.close(); }
});

test('logout never ends or removes the Mac app\'s key', async () => {
  const folder = home();
  const store = keyStore({ home: folder, platform: 'linux' });
  store.write(KEY);
  const said = await main(['logout'], { ...seamsFor(folder), store });
  assert.equal(said, settings.words.signed_out_elsewhere_kept);
  assert.equal(store.read(), KEY);
});

test('setup: the program is copied and linked, each app gets its skill once, and nothing it did not make is replaced', () => {
  const folder = home();
  mkdirSync(join(folder, '.claude'));
  mkdirSync(join(folder, '.codex'));
  const first = installProgram({ home: folder });
  assert.deepEqual(first.map(row => row.outcome), Array.from({ length: settings.install.files.length + 1 }, () => 'written'), 'each declared program file and the link are installed');
  assert.ok(settings.install.files.includes('local-door.mjs'), 'the program\'s door reader is installed with it');
  const installedProgram = settings.install.folder.startsWith('~/') ? join(folder, settings.install.folder.slice(2)) : settings.install.folder;
  for (const file of settings.install.files) assert.deepEqual(readFileSync(join(installedProgram, file)), readFileSync(new URL(`../do-work/${file}`, import.meta.url)), `${file} is the current source installed for the command consumer`);
  const link = join(folder, '.local/bin/example');
  assert.equal(readlinkSync(link), join(folder, '.example/cli/program/command.mjs'));
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.ok(installProgram({ home: folder }).every(row => row.outcome === 'unchanged'));

  const skills = installSkills({ home: folder, env: {}, text: 'name: example-cli\nbody\n' });
  assert.deepEqual(skills.map(row => [row.app, row.outcome]), [['Claude Code', 'written'], ['Codex', 'written']]);
  assert.equal(readFileSync(join(folder, '.claude/skills/example-cli/SKILL.md'), 'utf8'), 'name: example-cli\nbody\n');
  assert.ok(installSkills({ home: folder, env: {}, text: 'name: example-cli\nbody\n' }).every(row => row.outcome === 'unchanged'));
  assert.equal(installSkills({ home: folder, env: {}, text: 'name: example-cli\nnew\n' })[0].outcome, 'updated');
  writeFileSync(join(folder, '.codex/skills/example-cli/SKILL.md'), 'name: somebody-else\n');
  assert.equal(installSkills({ home: folder, env: {}, text: 'name: example-cli\nnew\n' })[1].outcome, 'refused');
  assert.deepEqual(installSkills({ home: folder, env: { CODEX_HOME: join(folder, 'elsewhere') }, only: ['codex'], text: 'name: example-cli\n' }).map(row => row.path), [join(folder, 'elsewhere/skills/example-cli/SKILL.md')]);

  const moved = home();
  mkdirSync(join(moved, '.local/bin'), { recursive: true });
  symlinkSync(join(moved, 'a-retired-program-that-is-gone.mjs'), join(moved, '.local/bin/example'));
  assert.equal(installProgram({ home: moved }).at(-1).outcome, 'updated', 'a link to another program, even a missing one, is replaced');
  assert.equal(readlinkSync(join(moved, '.local/bin/example')), join(moved, '.example/cli/program/command.mjs'));

  const other = home();
  mkdirSync(join(other, '.local/bin'), { recursive: true });
  writeFileSync(join(other, '.local/bin/example'), 'a program of its own');
  assert.equal(installProgram({ home: other }).at(-1).outcome, 'refused');
  assert.equal(readFileSync(join(other, '.local/bin/example'), 'utf8'), 'a program of its own');
});

test('several accounts on one computer each keep their own key: a Keychain entry or file per account id, the single entry unchanged (F-0518)', () => {
  const folder = home();
  const A = `nm_${'a'.repeat(32)}`;
  const B = `nm_${'b'.repeat(32)}`;
  const first = keyStore({ home: folder, platform: 'linux', account: 'acct_one' });
  const second = keyStore({ home: folder, platform: 'linux', account: 'acct_two' });
  const single = keyStore({ home: folder, platform: 'linux' });
  first.write(A); second.write(B);
  assert.deepEqual([first.read(), second.read(), single.read()], [A, B, null]);
  first.forget();
  assert.deepEqual([first.read(), second.read()], [null, B]);
  assert.throws(() => keyStore({ home: folder, platform: 'linux', account: '../x' }), /letters, digits/);
  const asked = [];
  const exec = (command, args, options) => { asked.push({ args, input: options.input }); return { status: 0, stdout: `${A}\n` }; };
  const keychain = keyStore({ platform: 'darwin', exec, account: 'acct_one' });
  keychain.read(); keychain.write(A); keychain.forget();
  assert.deepEqual(asked[0].args, ['find-generic-password', '-a', 'example:acct_one', '-s', settings.keychain_item, '-w']);
  assert.match(asked[1].input, new RegExp(`^add-generic-password -U -a example:acct_one -s ${settings.keychain_item} -w ${A}\\n$`));
  assert.deepEqual(asked[2].args, ['delete-generic-password', '-a', 'example:acct_one', '-s', settings.keychain_item]);
  assert.ok(asked.every(call => !call.args.join(' ').includes(A)));
});

test('a refused engine call names the step that refused it: the message ends with the cause the engine answers', async () => {
  const reply = { jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'refused' }],
    structuredContent: { code: 'original_workspace_source_unavailable', outcome: 'unknown', cause: 'src/x.rs:118:36:Error::Invalid#abc' } } };
  const fetchImpl = async () => new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  const client = engineClient({ door: doorAt('http://127.0.0.1:9/mcp', { local: true }), credential: keyCredential, fetchImpl, rules: quick, wait: noWait });
  await assert.rejects(client.op('@tools', 'tools:list', {}), error => error.code === 'original_workspace_source_unavailable'
    && error.answer.cause === 'src/x.rs:118:36:Error::Invalid#abc' && /Cause: src\/x\.rs:118:36:Error::Invalid#abc$/.test(error.detail));
});

test('a refused call says the engine\'s own words for its code, and this command\'s words only when the engine sends none', async () => {
  const refusedWith = structuredContent => engineClient({ door: doorAt('http://127.0.0.1:9/mcp', { local: true }), credential: keyCredential, rules: quick, wait: noWait,
    fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'refused' }], structuredContent } }), { status: 200, headers: { 'content-type': 'application/json' } }) });
  const told = 'This answer is 70000 bytes; one answer may be at most 65536.';
  await assert.rejects(refusedWith({ code: 'tools_run_answer_too_large', outcome: 'unknown', detail: told }).op('@tools', 'tools:run', {}), error => error.message.startsWith(told));
  await assert.rejects(refusedWith({ code: 'tools_run_answer_too_large', outcome: 'unknown' }).op('@tools', 'tools:run', {}), error => !error.message.startsWith(told) && error.code === 'tools_run_answer_too_large');
});

test('a refused call names the request key it was sent under, so the caller can quote it', async () => {
  const reply = { jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'refused' }],
    structuredContent: { code: 'original_input_refused', outcome: 'not_started' } } };
  const fetchImpl = async () => new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  const client = engineClient({ door: doorAt('http://127.0.0.1:9/mcp', { local: true }), credential: keyCredential, fetchImpl, rules: quick, wait: noWait });
  await assert.rejects(opWhole(client, null, 'tools:run', {}, { requestKey: 'quote-me-7' }), error => /Reference: quote-me-7\./.test(error.message));
});

test('a task shows its own words, and its title on a line of its own', () => {
  const lines = taskLines({ id: task, status: 'To do', assignees: ['ai:codex-on-mac'], description: 'Fix the build', title: 'build-fix' });
  assert.deepEqual(lines.slice(1), ['  description: Fix the build', '  title: build-fix']);
  assert.deepEqual(taskLines({ id: task, status: 'To do', title: 'only-a-title' }).slice(1), ['  title: only-a-title']);
});

// The account files as the door answers them, in memory: a resumable upload takes sequential pieces and its finish keeps the file.
function filesDoor() {
  const files = new Map(), uploads = new Map(), pieces = [], identities = new Map();
  const identityOf = name => { if (!identities.has(name)) identities.set(name, makeHashCodeHexFromBytes(files.get(name))); return identities.get(name); };
  return {
    files, pieces, ops: {
      '@namespace write_file_start': input => { if (files.has(input.name)) return { state: 'finished' }; uploads.set(input.upload_id, { ...input, got: [] }); return { state: 'open' }; },
      '@namespace write_file_piece': input => {
        const upload = uploads.get(input.upload_id), bytes = Buffer.from(input.content_base64, 'base64');
        assert.equal(input.offset, upload.got.reduce((sum, part) => sum + part.length, 0), 'pieces arrive in order');
        assert.ok(bytes.length <= settings.keep.piece_bytes, 'a piece is at most the span size');
        pieces.push(bytes.length); upload.got.push(bytes); return { accepted: true };
      },
      '@namespace write_file_finish': input => { const upload = uploads.get(input.upload_id); files.set(input.name, Buffer.concat(upload.got)); assert.equal(files.get(input.name).length, upload.byte_length); return { state: 'finished' }; },
      '@namespace find_file': input => ({ identity: identityOf(input.name_or_identity), byte_length: files.get(input.name_or_identity).length }),
      '@namespace read_file': input => {
        const bytes = files.get(input.name_or_identity), page = bytes.subarray(input.offset, input.offset + Math.min(input.length, 262144));
        return { identity: identityOf(input.name_or_identity), byte_length: bytes.length, offset: input.offset, bytes_returned: page.length, encoding: 'base64', content: page.toString('base64') };
      },
    },
  };
}

test('keep: a 10-byte result stays on the task row and a 50 MB one is kept as a file the row names, each read back whole through one call', async () => {
  const kept = filesDoor();
  const store = recordStore([taskOf('record:calendar-task:small', { status: 'In progress', taken_by: me.ai_id, taken_at: '2026-11-19T12:00:00.000Z' }), taskOf('record:calendar-task:big', { status: 'In progress', taken_by: me.ai_id, taken_at: '2026-11-19T12:00:00.000Z' })]);
  const overrides = {
    [settings.tasks.tools.finish]: input => {
      const value = store.get(input.input.id);
      store.put(input.input.id, 'calendar-task', { ...value, status: 'Done', result: input.input.result });
      return { id: input.input.id, moved: true, from: 'In progress', to: 'Done', task: { id: input.input.id, ...store.get(input.input.id) } };
    },
    [settings.tasks.tools.see]: input => ({ tasks: [{ id: input.input.id, ...store.get(input.input.id) }], more: false }),
  };
  const fake = await fakeDoor({ ops: { ...kept.ops, ...taskDoorOps(store, { overrides }) } });
  try {
    const stdinOf = bytes => { const stream = new PassThrough(); stream.end(bytes); return stream; };
    const seams = stdin => seamsFor(home(), { localDoor: () => fake.mcp, stdin });
    await main(['finish', 'record:calendar-task:small'], seams(stdinOf(Buffer.from('0123456789'))));
    assert.equal(store.get('record:calendar-task:small').result, '0123456789', 'a result that fits is the row\'s own text');
    assert.equal(kept.files.size, 0, 'nothing is kept as a file for it');
    assert.equal(await main(['tasks', 'record:calendar-task:small', '--result'], seams()), '0123456789');
    const text = Buffer.alloc(50 * 1024 * 1024, 'abcdefghij\n');
    await main(['finish', 'record:calendar-task:big'], seams(stdinOf(text)));
    assert.match(store.get('record:calendar-task:big').result, /^Kept as file \/task-results\/record-calendar-task-big\/result \(52428800 bytes, 1f:[0-9a-f]{64}\)\. Read it whole: example tasks record:calendar-task:big --result$/);
    assert.ok(store.get('record:calendar-task:big').result.length < 300, 'the row holds the pointer, not the bytes');
    assert.equal(kept.files.get('/task-results/record-calendar-task-big/result').length, text.length);
    assert.equal(kept.pieces.length, Math.ceil(text.length / settings.keep.piece_bytes));
    const back = await main(['tasks', 'record:calendar-task:big', '--result'], seams());
    assert.equal(back.length, text.length, 'the whole 50 MB comes back through one call');
    assert.equal(back, text.toString('utf8'));
    const before = kept.pieces.length;
    await main(['finish', 'record:calendar-task:big'], seams(stdinOf(text)));
    assert.equal(kept.pieces.length, before, 'a retried keep is the same upload: the file already kept is not sent again');
    assert.equal(fake.calls.filter(call => call.method === 'tools:list').every(call => call.input.tool === settings.tasks.tools.finish), true, 'the limit is read from the finishing tool, never typed');
  } finally { await fake.close(); }
});

test('keep: a door that states no most length for the result refuses before anything is kept or finished', async () => {
  const kept = filesDoor();
  const store = recordStore([taskOf('record:calendar-task:x', { status: 'In progress', taken_by: me.ai_id, taken_at: '2026-11-19T12:00:00.000Z' })]);
  const fake = await fakeDoor({ ops: { ...kept.ops, ...taskDoorOps(store), '@tools tools:list': () => ({ id: settings.tasks.tools.finish, input_schema: { properties: { result: { type: 'string' } } } }),
    '@tools tools:run': () => { throw new Error('finish must not run'); } } });
  try {
    await assert.rejects(main(['finish', 'record:calendar-task:x', 'done'], seamsFor(home(), { localDoor: () => fake.mcp })), /states no most length/);
    assert.equal(kept.files.size, 0);
  } finally { await fake.close(); }
});

test('bearer: whatever kind of key or token EXAMPLE_KEY holds reaches the door unchanged; a value of no declared kind is not sent', async () => {
  const apiKey = `tr_${'AbCdEfGh'.repeat(8)}`;
  const token = `${Buffer.from('{"typ":"at+jwt"}').toString('base64url')}.${Buffer.from('{"sub":"x"}').toString('base64url')}.${'s'.repeat(20)}`;
  const nobody = { where: 'nothing kept', read: () => null, write: () => {} };
  const keptKey = `nm_${'Zz09_-'.repeat(7)}`; // a kept key was only ever required to start with nm_: it need not be hex
  const fake = await fakeDoor({ bearers: [KEY, keptKey, apiKey, token] });
  try {
    for (const bearer of [KEY, keptKey, apiKey, token]) {
      const said = await main(['whoami'], seamsFor(home(), { localDoor: () => fake.mcp, store: nobody, env: { CLAUDECODE: '1', EXAMPLE_KEY: bearer } }));
      assert.match(said, /^You're signed in to Example\./, 'the door took the bearer exactly as given');
    }
    assert.deepEqual((await credentialFor({ env: { EXAMPLE_KEY: apiKey }, store: nobody, grants: noGrants })).bearer, apiKey);
    await assert.rejects(credentialFor({ env: { EXAMPLE_KEY: 'not a key' }, store: nobody, grants: noGrants }), /not a kind of key or token/, 'a value no shape row matches is refused, not skipped');
    assert.deepEqual(settings.bearers.shapes.map(row => row.kind), ['account key', 'API key', 'signed token'], 'the kinds are DATA');
  } finally { await fake.close(); }
});

test('bearer: a EXAMPLE_KEY of no declared kind is refused and never replaced by the kept key; the kept key goes only to the local or the public door', async () => {
  const fake = await fakeDoor();
  try {
    const seams = env => seamsFor(home(), { localDoor: () => null, env: { CLAUDECODE: '1', ...env } });
    await assert.rejects(main(['whoami', '--origin', fake.origin], seams({ EXAMPLE_KEY: 'not a key' })), error => error.status === 2 && /not a kind of key or token/.test(error.message));
    assert.equal(fake.calls.length, 0, 'nothing was sent to the door, least of all the kept key');
    await assert.rejects(main(['whoami', '--origin', fake.origin], seams({})), error => error.status === 3 && /was not sent to a different Example/.test(error.message));
    assert.equal(fake.calls.length, 0, 'the kept key is not sent to a door that is neither local nor public');
    assert.match(await main(['whoami', '--origin', fake.origin], seams({ EXAMPLE_KEY: KEY })), /^You're signed in to Example\./, 'a key the person gives for that door is sent');
  } finally { await fake.close(); }
});

test('a local door is the app\'s loopback address, a sign-in of the origin it serves goes there, and login asks the engine to hold the person', async () => {
  const { localDoorAddress } = await import('../do-work/local-door.mjs');
  const declaration = JSON.stringify({ local_runtime: { computer: { listen_host: '127.0.0.1', port: 8788, public_origin: 'https://computer.example' } } });
  assert.equal(localDoorAddress({ runtime: '/App/Contents/MacOS/node', read: () => declaration }), 'http://127.0.0.1:8788/mcp');
  assert.throws(() => localDoorAddress({ runtime: '/App/Contents/MacOS/node', read: () => { throw new Error('none'); } }), /installed Mac app/);
  const local = 'http://127.0.0.1:8788/mcp';
  const door = doorFor({ credential: { kind: 'sign-in', origin: 'https://computer.example', resource: local }, localMcp: local });
  assert.deepEqual([door.local, door.mcp, 'host' in door], [true, local, false], 'a pass made for the resource this computer serves goes to the local door, with no Host of its own');
  const other = doorFor({ credential: { kind: 'sign-in', origin: 'https://elsewhere.example', resource: 'https://elsewhere.example/mcp' }, localMcp: local });
  assert.deepEqual([other.local, other.mcp], [false, 'https://elsewhere.example/mcp'], 'a pass made for another resource does not');
  const fake = await fakeDoor({ bearers: [KEY] });
  try {
    assert.equal(await addPersonHere({ socket: null, bearer: KEY }), null, 'a computer with no engine socket adds no one');
    assert.deepEqual(await addPersonHere({ socket: fake.socket, bearer: KEY }), { person: 'person-1', added: true });
    assert.deepEqual(fake.added, [`Bearer ${KEY}`], 'the pass is sent to the engine\'s own socket, as the bearer');
  } finally { await fake.close(); }
  const refusing = createServer((request, response) => response.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"persons_are_added_at_this_computer"}'));
  const refusingSocket = join(mkdtempSync(join(tmpdir(), 'td-')), 's');
  await new Promise(resolve => refusing.listen(refusingSocket, resolve));
  try {
    await assert.rejects(addPersonHere({ socket: refusingSocket, bearer: KEY }), error => error.message === settings.words.not_taken_in && error.detail.endsWith('answered 403 persons_are_added_at_this_computer.'));
  } finally { refusing.close(); }
  const without = createServer((request, response) => response.writeHead(404).end());
  const withoutSocket = join(mkdtempSync(join(tmpdir(), 'td-')), 's');
  await new Promise(resolve => without.listen(withoutSocket, resolve));
  try {
    await assert.rejects(addPersonHere({ socket: withoutSocket, bearer: KEY }), error => error.message === settings.words.not_taken_in && error.notTaken === true, 'an engine with no add route has not taken the person in: there is no skip');
  } finally { without.close(); }
});

// ── The login journey: the person is held at this computer's engine before anything asks who they are, and every
// sentence the person reads is plain ───────────────────────────────────────────────────────────────────────────────

const passFor = (email, aud) => `${Buffer.from('{"typ":"at+jwt"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'p', email, ...(aud ? { aud } : {}) })).toString('base64url')}.${'s'.repeat(20)}`;
const signInServer = pass => (url, raw, request, send) => {
  const at = path => `http://${request.headers.host}${path}`;
  if (url.pathname === '/.well-known/oauth-authorization-server') return send(200, { authorization_endpoint: at('/api/auth/oauth2/authorize'), token_endpoint: at('/api/auth/oauth2/token') });
  if (url.pathname === settings.protected_resource_path) return send(200, { resource: at('/mcp'), authorization_servers: [at('')] });
  return new URLSearchParams(raw).get('grant_type') === 'authorization_code' ? send(200, { access_token: pass, refresh_token: 'refresh-1', expires_in: 3600 }) : send(400, { error: 'unexpected' });
};
const openAndReturn = opened => async url => { const asked = new URL(url); opened.push(asked); await fetch(`${asked.searchParams.get('redirect_uri')}?code=code-1&state=${asked.searchParams.get('state')}`); };
const grantsKept = initial => { const box = { value: initial }; return { where: 'test sign-in', read: () => box.value, write: value => { box.value = value; }, forget: () => { box.value = null; }, box }; };

test('login with a new person: the engine is asked to hold them first, then who they are, and the person reads one line with their email', async () => {
  const pass = passFor('person@example.com');
  const fake = await fakeDoor({ bearers: [pass], holdsAddedOnly: true, oauth: signInServer(pass) });
  try {
    const opened = [];
    const said = await main(['login', '--origin', fake.origin], { store: { read: () => null, where: 'no key' }, grants: grantsKept(null), state: stateOf({ home: home() }), open: openAndReturn(opened), env: {}, agentSocket: () => fake.socket, localDoor: () => fake.mcp, computerName: 'Mac', model: null, wait: noWait });
    assert.equal(said, "You're signed in to Example as person@example.com.");
    assert.deepEqual(fake.order, ['persons/add', 'whoami'], 'the person is held before the engine is asked who they are');
    assert.equal(opened.length, 1);
  } finally { await fake.close(); }
});

test('login when already signed in and held: one line, nothing asked of the browser', async () => {
  const pass = passFor('person@example.com');
  const fake = await fakeDoor({ bearers: [pass], holdsAddedOnly: true, oauth: signInServer(pass) });
  try {
    const opened = [];
    const grants = grantsKept({ access_token: pass, refresh_token: 'refresh-1', asked: settings.scope, expires_at_ms: Date.now() + 3600_000, client_id: 'c', origin: fake.origin, token_endpoint: `${fake.origin}/api/auth/oauth2/token`, resource: `${fake.origin}/mcp` });
    const seams = { store: { read: () => null, where: 'no key' }, grants, state: stateOf({ home: home() }), open: openAndReturn(opened), env: {}, agentSocket: () => fake.socket, localDoor: () => fake.mcp, computerName: 'Mac', model: null, wait: noWait };
    assert.equal(await main(['login', '--origin', fake.origin], seams), "You're signed in to Example as person@example.com.");
    assert.deepEqual(fake.order, ['persons/add', 'whoami'], 'a sign-in the engine had not yet been told about is held first here too');
    assert.equal(opened.length, 0, 'no browser');
    assert.equal(await main(['whoami', '--origin', fake.origin], seams).then(text => text.split('\n')[0]), "You're signed in to Example as person@example.com.");
  } finally { await fake.close(); }
});

test('login with a kept sign-in the engine refuses, for any reason, makes one new browser sign-in; a new one refused too is said, and nothing more is tried', async () => {
  const fresh = passFor('person@example.com');
  const kept = fake => grantsKept({ access_token: passFor('old@example.com'), refresh_token: 'refresh-0', expires_at_ms: Date.now() + 3600_000, client_id: 'c', origin: fake.origin, token_endpoint: `${fake.origin}/api/auth/oauth2/token`, resource: `${fake.origin}/mcp` });
  const run = async (why, then, bearers = [fresh]) => {
    const fake = await fakeDoor({ bearers, holdsAddedOnly: true, oauth: signInServer(fresh), why });
    try {
      const opened = [];
      const grants = kept(fake);
      const seams = { store: { read: () => null, where: 'no key' }, grants, state: stateOf({ home: home() }), open: openAndReturn(opened), env: {}, agentSocket: () => fake.socket, localDoor: () => fake.mcp, computerName: 'Mac', model: null, wait: noWait };
      await then(await main(['login', '--origin', fake.origin], seams).then(said => ({ said }), error => ({ error })), opened, grants);
    } finally { await fake.close(); }
  };
  for (const why of ['exp', 'revoked', 'aud', 'iss', null]) await run(why, ({ said }, opened, grants) => {
    assert.equal(said, "You're signed in to Example as person@example.com.", String(why));
    assert.equal(opened.length, 1, 'one browser sign-in');
    assert.equal(grants.box.value.access_token, fresh);
  });
  await run('aud', ({ said, error }, opened) => {
    assert.equal(said, undefined);
    assert.equal(error.status, 3);
    assert.ok(error.message.startsWith('Example did not accept your new sign-in'), error.message);
    assert.equal(opened.length, 1, 'one browser sign-in, never a second');
  }, []);
});

test('a sign-in goes to the engine its pass was made for, whichever engine this computer runs; no host is compared', async () => {
  const pass = passFor('person@example.com');
  const mine = await fakeDoor({ bearers: [pass] });
  const theirs = await fakeDoor({ bearers: [pass], holdsAddedOnly: false });
  try {
    const grant = grantsKept({ access_token: pass, refresh_token: null, expires_at_ms: null, client_id: 'c', origin: 'https://issuer.example', token_endpoint: 'https://issuer.example/t', resource: `${theirs.origin}/mcp` });
    const said = await main(['whoami'], { store: { read: () => null, where: 'none' }, grants: grant, state: stateOf({ home: home() }), env: {}, agentSocket: () => mine.socket, localDoor: () => mine.mcp, computerName: 'Mac', model: null, wait: noWait });
    assert.match(said, /^You're signed in to Example as person@example\.com\.\nExample at: 127\.0\.0\.1:\d+\n/);
    assert.deepEqual([theirs.order, mine.order], [['whoami'], []], 'the engine the pass is for answered; this computer\'s was not asked, and nothing was added at it');
  } finally { await mine.close(); await theirs.close(); }
});

test('login when Example on this computer is not running: one plain line saying what to do, and the technical line kept in the error', async () => {
  const gone = createServer(() => {});
  await new Promise(resolve => gone.listen(0, '127.0.0.1', resolve));
  const port = gone.address().port;
  await new Promise(resolve => gone.close(resolve));
  const seams = { store: { read: () => KEY, where: 'a kept key' }, grants: noGrants, state: stateOf({ home: home() }), env: {}, agentSocket: () => join(tmpdir(), 'no-such-engine.sock'), localDoor: () => `http://127.0.0.1:${port}/mcp`, computerName: 'Mac', model: null, wait: noWait };
  await assert.rejects(main(['login'], seams), error => error.message === settings.words.not_running
    && /^Nothing answered at .*no-such-engine\.sock: ENOENT/.test(error.detail));
});

test('the engine socket is read from the computer config, never named in code', () => {
  const folder = home();
  assert.equal(findAgentSocket({ home: folder }), null, 'no computer config: no socket');
  const file = join(folder, settings.computer_config_files[0].replace(/^~\//, ''));
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ agent_socket: '/some/engine.sock', listen: '127.0.0.1:1' }));
  assert.equal(findAgentSocket({ home: folder }), '/some/engine.sock');
});

test('whoami holds a pass the engine has not held (an engine started again) before it asks who they are', async () => {
  const pass = passFor('person@example.com');
  const fake = await fakeDoor({ bearers: [pass], holdsAddedOnly: true });
  try {
    const said = await main(['whoami', '--origin', fake.origin], { ...seamsFor(home(), { localDoor: () => fake.mcp, agentSocket: () => fake.socket, store: { read: () => null, where: 'none' }, env: { CLAUDECODE: '1', EXAMPLE_KEY: pass } }) });
    assert.equal(said.split('\n')[0], "You're signed in to Example as person@example.com.");
    assert.deepEqual(fake.order, ['persons/add', 'whoami']);
  } finally { await fake.close(); }
});

test('login with a kept key the engine will not hold signs in at the browser instead of stopping', async () => {
  const pass = passFor('person@example.com');
  const fake = await fakeDoor({ bearers: [pass, KEY], holdsAddedOnly: true, oauth: signInServer(pass) });
  const refusing = createServer((request, response) => response.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"sign_in_unavailable"}'));
  const refusingSocket = join(mkdtempSync(join(tmpdir(), 'td-')), 's');
  await new Promise(resolve => refusing.listen(refusingSocket, resolve));
  try {
    const opened = [];
    const answers = [refusingSocket, fake.socket];
    const said = await main(['login', '--origin', fake.origin], { store: { read: () => KEY, where: 'a kept key' }, grants: grantsKept(null), state: stateOf({ home: home() }), open: openAndReturn(opened), env: {}, agentSocket: () => answers.shift() ?? fake.socket, localDoor: () => fake.mcp, computerName: 'Mac', model: null, wait: noWait });
    assert.equal(said, "You're signed in to Example as person@example.com.");
    assert.equal(opened.length, 1);
  } finally { refusing.close(); await fake.close(); }
});

test('whoami with no sign-in and a kept key the engine will not read says not signed in at once, with no retries', async () => {
  let asked = 0;
  const server = createServer((request, response) => { asked += 1; response.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"keys_unavailable"}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const socket = join(mkdtempSync(join(tmpdir(), 'td-')), 's');
  const engine = createServer((request, response) => response.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"sign_in_unavailable"}'));
  await new Promise(resolve => engine.listen(socket, resolve));
  try {
    const started = Date.now();
    await assert.rejects(main(['whoami'], seamsFor(home(), { localDoor: () => `http://127.0.0.1:${server.address().port}/mcp`, agentSocket: () => socket, wait: async () => { throw new Error('waited for a retry'); } })),
      error => error.status === 3 && error.message === settings.words.no_credential);
    assert.ok(Date.now() - started < 2000);
    const client = engineClient({ door: doorAt(`http://127.0.0.1:${server.address().port}/mcp`), credential: keyCredential, wait: async () => { throw new Error('waited for a retry'); } });
    await assert.rejects(client.whoami(), error => error.status === 4);
    assert.equal(asked, 1, 'a question of who the person is is asked once, never retried');
  } finally { server.close(); engine.close(); }
});

test('the program runs under the Mac app\'s own node when the app is installed, and under the current one otherwise', async () => {
  const { appNodeToRunUnder } = await import('../do-work/command.mjs');
  assert.equal(appNodeToRunUnder({ rules: { ...settings, mac_app: '/no/such/app' } }), null);
  assert.equal(appNodeToRunUnder({ rules: { ...settings, mac_app: '/no/such/app' }, execPath: process.execPath }), null);
  const folder = home();
  mkdirSync(join(folder, 'Contents', 'MacOS'), { recursive: true });
  symlinkSync(process.execPath, join(folder, 'Contents', 'MacOS', 'node'));
  assert.equal(appNodeToRunUnder({ rules: { ...settings, mac_app: folder } }), null, 'already running under it');
  assert.equal(appNodeToRunUnder({ rules: { ...settings, mac_app: folder }, execPath: '/bin/sh', env: {} }) !== null, true);
  assert.equal(appNodeToRunUnder({ rules: { ...settings, mac_app: folder }, execPath: '/bin/sh', env: { [settings.env.rerun]: '1' } }), null, 'a re-run never starts another');
  const upper = join(home(), 'Upper.app');
  mkdirSync(join(upper, 'Contents', 'MacOS'), { recursive: true });
  symlinkSync(process.execPath, join(upper, 'Contents', 'MacOS', 'node'));
  assert.equal(appNodeToRunUnder({ rules: { ...settings, mac_app: upper.replace('Upper.app', 'upper.app') }, execPath: process.execPath, env: {} }), null, 'the same node spelled in another case is the same node');
});

test('the sign-in link is always said, for a computer with no browser; the address a phone ended on can be pasted; a second sign-in while one waits says so in plain words', async () => {
  const pass = passFor('person@example.com');
  const fake = await fakeDoor({ bearers: [pass], oauth: signInServer(pass) });
  try {
    const said = [];
    const open = async url => { const asked = new URL(url); await fetch(`${asked.searchParams.get('redirect_uri')}?code=code-1&state=${asked.searchParams.get('state')}`); };
    await signInWithBrowser({ origin: fake.origin, open: () => {}, say: text => said.push(text), typed: () => ({ line: new Promise(() => {}), stop: () => {} }), now: () => 1000, rules: { ...settings, sign_in_wait_seconds: 0.2 } }).catch(() => null);
    assert.equal(said.length, 1);
    assert.ok(said[0].startsWith('If your browser did not open, open this link to sign in: ') && said[0].includes('code_challenge='), said[0]);
    // Signed in on a phone: the address its browser ended on is pasted here, and the sign-in goes through with no browser on this computer.
    let paste;
    const pasted = { line: new Promise(resolve => { paste = resolve; }), stop: () => {} };
    const phone = await signInWithBrowser({ origin: fake.origin, open: () => {}, typed: () => pasted, now: () => 1000,
      say: text => { const link = new URL(text.match(/https?:\/\/\S+/)[0]); paste(`${link.searchParams.get('redirect_uri')}?code=code-1&state=${link.searchParams.get('state')}`); } });
    assert.equal(phone.access_token, pass);
    let wrong;
    const stale = { line: new Promise(resolve => { wrong = resolve; }), stop: () => {} };
    await assert.rejects(signInWithBrowser({ origin: fake.origin, open: () => {}, typed: () => stale, rules: { ...settings, sign_in_wait_seconds: 0.3 },
      say: () => wrong('http://127.0.0.1:54718/callback?code=code-9&state=someone-elses') }), error => error.message.startsWith('No sign-in arrived'), 'a pasted address of another sign-in is ignored');
    const holder = createServer(() => {});
    await new Promise(resolve => holder.listen(settings.client.redirect_port, '127.0.0.1', resolve));
    try {
      await assert.rejects(signInWithBrowser({ origin: fake.origin, open, say: () => {}, typed: () => ({ line: new Promise(() => {}), stop: () => {} }) }), error => error.message === settings.words.sign_in_waiting && error.status === 4);
    } finally { await new Promise(resolve => holder.close(resolve)); }
  } finally { await fake.close(); }
});

test('a callback with another sign-in\'s state is told it is old and ignored; the run keeps waiting for its own', async () => {
  const pass = passFor('person@example.com');
  const fake = await fakeDoor({ bearers: [pass], oauth: signInServer(pass) });
  try {
    const seen = [];
    const open = async url => {
      const asked = new URL(url);
      const stale = await fetch(`${asked.searchParams.get('redirect_uri')}?code=old-code&state=someone-elses`, { redirect: 'manual' });
      seen.push([stale.status, stale.headers.get('location')]);
      await fetch(`${asked.searchParams.get('redirect_uri')}?code=code-1&state=${asked.searchParams.get('state')}`);
    };
    const grant = await signInWithBrowser({ origin: fake.origin, open, now: () => 1000 });
    assert.equal(grant.access_token, pass, 'the exchange used the run\'s own code');
    assert.deepEqual(seen[0], [302, `${fake.origin}/sign-in/done?result=old`]);
  } finally { await fake.close(); }
});

test('a door a sign-in was not made for says so in plain words; the aud is read without checking', async () => {
  assert.deepEqual(audiencesOf(passFor('a@example.com', ['x', 'y'])), ['x', 'y']);
  assert.deepEqual(audiencesOf(passFor('a@example.com', 'x')), ['x']);
  assert.deepEqual(audiencesOf('garbage'), []);
  const fake = await fakeDoor({ bearers: [KEY], status: null });
  try {
    const client = engineClient({ door: doorAt(`${fake.origin}/mcp`), credential: { kind: 'sign-in', bearer: passFor('a@example.com', ['https://other.example/mcp']), where: 'g' }, rules: quick, wait: noWait });
    await assert.rejects(client.whoami(), error => error.status === 3 && error.message === settings.words.not_covered && /not in the audience/.test(error.detail));
  } finally { await fake.close(); }
});

test('login for this computer\'s own engine, named, says so when it is not running and opens nothing', async () => {
  const gone = createServer(() => {});
  await new Promise(resolve => gone.listen(0, '127.0.0.1', resolve));
  const port = gone.address().port;
  await new Promise(resolve => gone.close(resolve));
  const opened = [];
  const seams = { store: { read: () => null, where: 'none' }, grants: grantsKept(null), state: stateOf({ home: home() }), open: openAndReturn(opened), env: {}, agentSocket: () => null, localDoor: () => `http://127.0.0.1:${port}/mcp`, computerName: 'Mac', model: null, wait: noWait };
  await assert.rejects(main(['login', '--origin', `http://127.0.0.1:${port}`], seams), error => error.message === settings.words.not_running);
  assert.equal(opened.length, 0);
});
