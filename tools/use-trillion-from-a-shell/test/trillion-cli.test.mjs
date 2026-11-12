import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import settings from '../do-work/trillion.json' with { type: 'json' };
import {
  TrillionError, agentOf, aiOf, aiRecordOf, allPages, groupsOf, argumentsFor, computerNameOf, computerOf, credentialFor, doorFor, grantStore, holdingOf, installProgram,
  installSkills, keyStore, main, modelOf, namesOf, parseArgs, pkce, placeOf, providerOf, publishRecord, render, repliesOf, sendNote,
  serveOnce, signInWithBrowser, stateOf, trillionClient, waitFor, workCall,
} from '../do-work/trillion.mjs';

const KEY = `nm_${'ab'.repeat(32)}`;
const ACCOUNT = 'f'.repeat(64);
const me = { agent_id: 'claude-code-on-mac', ai_id: 'ai:claude-code-on-mac', held_as: [], harness: 'Claude Code', app: 'Claude Code', model: null, provider: 'Anthropic', computer: 'Mac' };
const place = () => ({ repository: 'trillion', branch: 'main' });
const home = () => mkdtempSync(join(tmpdir(), 'trillion-cli-test-'));
const quick = { ...settings, retry_seconds: [0, 0, 0] };
const noWait = async () => {};
const noGrants = { where: 'test sign-in', read: () => null, write: () => {}, forget: () => {} };

// A stand-in engine door: /mcp answers initialize with the account in _meta, and run_resource_operation from `ops`
// (a function per "address method"); /oauth/* and /authorize from `oauth`. Bearers in `bearers` are admitted.
async function fakeDoor({ ops = {}, oauth = null, sse = false, bearers = [KEY], status = null } = {}) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (code, value, type = 'application/json') => response.writeHead(code, { 'content-type': type }).end(typeof value === 'string' ? value : JSON.stringify(value));
    if (url.pathname.startsWith('/oauth/') || url.pathname === '/authorize') return oauth(url, raw, request, send);
    if (status) return send(status, { error: 'refused' });
    if (!bearers.some(bearer => request.headers.authorization === `Bearer ${bearer}`)) return send(401, { error: 'Bearer authentication is required' });
    if (url.pathname !== '/mcp') return send(404, { error: 'Not found' });
    const message = JSON.parse(raw);
    let result;
    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, serverInfo: { name: 'fake' }, _meta: { [settings.engine.account_meta]: { account_id: ACCOUNT } } };
    else {
      const args = message.params.arguments;
      calls.push({ name: message.params.name, ...args });
      const handler = ops[`${args.address} ${args.method}`];
      const answer = handler ? await handler(args.input, args, calls) : { refused: `No ${args.method} at ${args.address}` };
      if (answer?.status) return send(answer.status, 'busy', 'text/plain');
      // A refusal the engine names by a code alone answers as the engine does: { code, outcome } and no words.
      result = answer?.code ? { isError: true, content: [{ type: 'text', text: 'The resource operation was refused.' }], structuredContent: { code: answer.code, outcome: 'not_started' } }
        : answer?.refused ? { isError: true, content: [{ type: 'text', text: answer.refused }], structuredContent: { error: { message: answer.refused, retryable: answer.retryable ?? false } } }
        : { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer };
    }
    const reply = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
    return sse ? send(200, `event: message\ndata: ${reply}\n\n`, 'text/event-stream') : send(200, reply);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, mcp: `${origin}/mcp`, calls, close: () => new Promise(resolve => server.close(resolve)) };
}
const keyCredential = { kind: 'key', bearer: KEY, where: 'test' };
const doorAt = (mcp, extra = {}) => ({ mcp, origin: new URL(mcp).origin, name: `the door ${mcp}`, local: false, public: false, localMcp: null, ...extra });
const seamsFor = (folder = home(), extra = {}) => ({ store: { read: () => KEY, where: 'test key' }, grants: noGrants, state: stateOf({ home: folder }), env: { CLAUDECODE: '1' },
  place, localDoor: () => null, computerName: 'Mac', model: null, wait: noWait, ...extra });

test('arguments: words and flags, with -- ending them', () => {
  assert.deepEqual(parseArgs(['send', 'any', 'fix', 'the', 'build', '--priority', '3', '--json']), { words: ['send', 'any', 'fix', 'the', 'build'], flags: { priority: '3', json: true }, rest: [] });
  assert.deepEqual(parseArgs(['serve', '--as=me', '--', 'claude', '-p', '--json']), { words: ['serve'], flags: { as: 'me' }, rest: ['claude', '-p', '--json'] });
  assert.throws(() => parseArgs(['send', '--as']), /--as needs a value/);
});

test('each work command is one row of the work table, with the input its Workshop work tool is given', () => {
  const parse = line => parseArgs(line);
  const call = (line, extra = {}) => argumentsFor(line[0], { words: parse(line).words.slice(1), flags: parse(line).flags }, { me, requestKey: 'k1', ...extra });
  assert.deepEqual(call(['send', 'any', 'fix', 'the', 'build']), { work: 'send', input: { as: me.ai_id, job: 'fix the build', key: 'k1', to: null } });
  assert.deepEqual(call(['send', 'codex-on-mac', 'review', '--priority', '5', '--outcome', 'tests pass', '--label', 'Review']).input,
    { as: me.ai_id, job: 'review', key: 'k1', to: 'ai:codex-on-mac', priority: 5, outcome: 'tests pass', label: 'Review' });
  assert.equal(call(['send', 'ai:codex-on-mac', 'x']).input.to, 'ai:codex-on-mac', 'an id that is already an ai id is kept');
  assert.equal(call(['send', 'any', 'x', '--key', 'mine']).input.key, 'mine');
  assert.throws(() => call(['send', 'any']), /Say the job/);
  assert.deepEqual(call(['work']), { work: 'see', input: { limit: settings.work_list_limit } });
  assert.deepEqual(call(['work', 'ai-job:1']), { work: 'see', input: { id: 'ai-job:1' } });
  assert.deepEqual(call(['work', '--status', 'waiting', '--to', 'codex', '--limit', '5']).input, { status: 'waiting', to: 'ai:codex', limit: 5 });
  assert.deepEqual(call(['take']), { work: 'take', input: { as: me.ai_id } });
  assert.deepEqual(call(['take', 'ai-job:1', '--mine']).input, { as: me.ai_id, id: 'ai-job:1', only_mine: true });
  assert.deepEqual(call(['finish', 'ai-job:1', 'done.', 'All', 'green.']), { work: 'change', input: { as: me.ai_id, id: 'ai-job:1', action: 'finish', result: 'done. All green.', summary: 'done. All green.' } });
  assert.deepEqual(call(['fail', 'ai-job:1', 'no', 'access']).input, { as: me.ai_id, id: 'ai-job:1', action: 'fail', result: 'no access' });
  assert.deepEqual(call(['stuck', 'ai-job:1', '--clear']).input, { as: me.ai_id, id: 'ai-job:1', action: 'unstuck' });
  assert.deepEqual(call(['stuck', 'ai-job:1', 'needs', 'a', 'sign-in']).input, { as: me.ai_id, id: 'ai-job:1', action: 'stuck', words: 'needs a sign-in' });
  assert.deepEqual(call(['release', 'ai-job:1', '--because', 'busy']).input, { as: me.ai_id, id: 'ai-job:1', action: 'release', because: 'busy' });
  assert.throws(() => call(['withdraw', 'ai-job:1']), /--reason/);
  assert.deepEqual(call(['withdraw', 'ai-job:1', '--reason', 'not needed']).input, { as: me.ai_id, id: 'ai-job:1', action: 'withdraw', because: 'not needed' });
  assert.deepEqual(call(['remove', 'ai-job:1']).input, { as: me.ai_id, id: 'ai-job:1', action: 'remove' });
  assert.throws(() => call(['dance']), error => error instanceof TrillionError && error.status === 2);
  assert.deepEqual(Object.values(settings.work.tools).sort(), ['tool:change-an-ai-job', 'tool:hand-a-job-to-an-ai', 'tool:see-ai-work', 'tool:see-my-ais', 'tool:take-an-ai-job']);
});

test('the agent id comes from --as, TRILLION_AGENT, or the AI app running the command', () => {
  assert.equal(computerOf('Work-Laptop.local'), 'work-laptop');
  assert.equal(computerOf('Mac.localdomain'), 'mac');
  assert.equal(agentOf({ env: { CLAUDECODE: '1' }, computer: 'mac', model: null }).agent_id, 'claude-code-on-mac');
  assert.equal(agentOf({ env: {}, computer: 'mac', model: null }).agent_id, 'terminal-on-mac');
  assert.equal(agentOf({ env: { TRILLION_AGENT: 'lane-7', CLAUDECODE: '1' }, computer: 'mac', model: null }).agent_id, 'lane-7');
  assert.equal(agentOf({ as: 'reviewer', env: { TRILLION_AGENT: 'lane-7' }, computer: 'mac', model: null }).agent_id, 'reviewer');
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
  const chosen = agentOf({ env: { TRILLION_AGENT: 'lane-7', CLAUDE_CODE_SESSION_ID: 's1', CLAUDECODE: '1' }, computer: 'mac', model: null });
  assert.deepEqual([chosen.agent_id, chosen.held_as], ['lane-7', []], 'a chosen id has no other id');
  assert.equal(agentOf({ as: 'a'.repeat(200), env: {}, model: null }).agent_id.length, 200);
  assert.throws(() => agentOf({ as: 'a'.repeat(201), env: {}, model: null }), error => error.status === 2 && /1 to 200 characters/.test(error.message));
  assert.throws(() => agentOf({ as: ' padded', env: {}, model: null }), /no space at either end/);
  assert.equal(agentOf({ env: { TRILLION_AGENT: '' }, computer: 'mac', model: null }).agent_id, 'terminal-on-mac', 'an empty TRILLION_AGENT chooses nothing');
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

test('a job taken under the computer id before the upgrade is moved as that id', () => {
  const session = { ...me, agent_id: 'claude-code-7d2e6f4a9b10-on-mac', ai_id: 'ai:claude-code-7d2e6f4a9b10-on-mac', held_as: ['claude-code-on-mac'] };
  const call = (line, held) => argumentsFor(line[0], parseArgs(line.slice(1)), { me: session, held });
  const old = { 'claude-code-on-mac ai-job:old': { said: '' } }, both = { ...old, 'claude-code-7d2e6f4a9b10-on-mac ai-job:new': { said: 'Fix the build' } };
  assert.equal(call(['finish', 'ai-job:old', 'done'], old).input.as, 'ai:claude-code-on-mac');
  assert.equal(call(['release', 'ai-job:old'], old).input.as, 'ai:claude-code-on-mac');
  assert.equal(call(['stuck', 'ai-job:old', 'a', 'sign-in'], old).input.as, 'ai:claude-code-on-mac');
  assert.equal(call(['finish', 'ai-job:new', 'done'], both).input.as, session.ai_id);
  assert.equal(call(['finish', 'ai-job:other', 'done'], both).input.as, session.ai_id, 'a job held nowhere here is this session\'s');
  assert.equal(call(['take'], both).input.as, session.ai_id, 'new work is always taken as this session');
  assert.deepEqual(holdingOf(session, { ...both, 'codex-on-mac ai-job:x': { said: '' } }), [{ id: 'ai-job:old', said: '' }, { id: 'ai-job:new', said: 'Fix the build' }]);
});

test('this AI\'s record carries facts only: owner from the door, app, model, provider, computer, where it works and what it holds, never a name, path or secret', () => {
  const now = new Date('2026-11-02T08:00:00.000Z');
  const fresh = aiRecordOf(me, { account: ACCOUNT, now, repository: 'trillion', branch: 'main', holding: [] });
  assert.deepEqual(fresh, { ...settings.ai_record.new, owner: ACCOUNT, agent_id: me.agent_id, app: 'Claude Code', model: null, provider: 'Anthropic', computer: 'Mac', harness: 'Claude Code',
    where: 'repository trillion, branch main, in a terminal on this computer', working_on: null, live: { ...settings.ai_record.new.live, seen_at: now.toISOString() } });
  // What a person set on the record (a nickname, an order, what it can do) is kept as it is; the facts are made current.
  const kept = aiRecordOf(me, { account: ACCOUNT, now, held: { nickname: 'Builder', order: 2, can: ['code'], app: 'Old', label: 'take-open-work-preflight', live: { minutes: 10, seen_at: 'x' } },
    holding: [{ id: 'ai-job:1', said: 'Review the login page' }] });
  assert.deepEqual([kept.nickname, kept.order, kept.can, kept.app, kept.live, kept.working_on], ['Builder', 2, ['code'], 'Claude Code', { how: 'heartbeat', minutes: 10, seen_at: now.toISOString() }, 'Review the login page']);
  assert.equal(aiRecordOf(me, { account: ACCOUNT, holding: [{ id: 'ai-job:1', said: '' }, { id: 'ai-job:2', said: '' }] }).working_on, 'ai-job:2 (and 1 more)');
  assert.equal(aiRecordOf(me, { account: ACCOUNT, branch: null, repository: 'trillion' }).where, 'repository trillion, branch none (detached), in a terminal on this computer');
  assert.equal(aiRecordOf(me, { account: ACCOUNT }).where, 'a terminal on this computer');

  // git answers: the remote's last part only (its address may carry a sign-in), and the branch.
  const answers = { 'rev-parse': { status: 0, stdout: '/home/someone/dev/checkout-2\nfeature/cards\n' }, config: { status: 0, stdout: 'https://someone:user-428d77ea@example.com/Trillion-X/trillion.git\n' } };
  const exec = (command, args) => answers[args[0]];
  assert.deepEqual(placeOf({ exec }), { repository: 'trillion', branch: 'feature/cards' });
  answers.config = { status: 1, stdout: '' };
  assert.deepEqual(placeOf({ exec }), { repository: 'checkout-2', branch: 'feature/cards' }, 'no remote: the top folder\'s own name, not its path');
  answers['rev-parse'] = { status: 0, stdout: '/x/y\nHEAD\n' };
  assert.equal(placeOf({ exec }).branch, null);
  answers['rev-parse'] = { status: 128, stdout: '' };
  assert.deepEqual(placeOf({ exec }), {}, 'outside a repository nothing is said');

  const env = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: '5b1f0c2e-8a4d-4e3b-9c1a-7d2e6f4a9b10', TRILLION_KEY: KEY, HOME: '/home/someone', SECRET_TOKEN: 'sk_live_abc' };
  const record = JSON.stringify(aiRecordOf(agentOf({ env, computer: 'mac', model: null }), { account: ACCOUNT, repository: 'trillion', branch: 'main' }));
  for (const value of [KEY, '/home/someone', 'sk_live_abc', '5b1f0c2e-8a4d']) assert.ok(!record.includes(value), `the record does not carry ${value}`);
});

test('send says when the receiver sees the job', () => {
  assert.match(sendNote({ job: { to: null } }), /^Any of your AIs can take it\./);
  assert.equal(sendNote({ job: { to: 'ai:codex-on-mac' } }), 'ai:codex-on-mac sees it the next time it runs trillion work or trillion take, or at once while trillion serve runs for it.');
});

test('the key and the sign-in: a 0600 file off macOS, and on macOS the Keychain is written on standard input, never in an argument', () => {
  const folder = home();
  const file = keyStore({ home: folder, platform: 'linux' });
  assert.equal(file.read(), null);
  file.write(KEY);
  assert.equal(file.read(), KEY);
  assert.equal(statSync(join(folder, '.trillion/cli/key')).mode & 0o777, 0o600);
  file.forget();
  assert.equal(file.read(), null);
  assert.throws(() => file.write('not-a-key'), /not a Trillion key/);

  const asked = [];
  const exec = (command, args, options) => { asked.push({ command, args, input: options.input }); return { status: 0, stdout: `${KEY}\n` }; };
  const keychain = keyStore({ platform: 'darwin', exec });
  assert.equal(keychain.read(), KEY);
  keychain.write(KEY);
  assert.ok(asked.every(call => !call.args.join(' ').includes(KEY)), 'no argument carries the key');
  assert.match(asked[1].input, new RegExp(`^add-generic-password -U -a trillion -s ${settings.keychain_item} -w ${KEY}\\n$`));

  const grant = { access_token: 'access-1', refresh_token: 'refresh-1', expires_at_ms: 5, client_id: 'c1', origin: 'https://example.test' };
  const signIns = grantStore({ home: folder, platform: 'linux' });
  assert.equal(signIns.read(), null);
  signIns.write(grant);
  assert.deepEqual(signIns.read(), grant);
  assert.equal(statSync(join(folder, '.trillion/cli', settings.grant.file)).mode & 0o777, 0o600);
  signIns.forget();
  assert.equal(signIns.read(), null);
  const kept = [];
  const keychainSignIns = grantStore({ platform: 'darwin', exec: (command, args, options) => { kept.push({ args, input: options.input }); return { status: 0, stdout: kept.find(call => call.input)?.input.split(' -w ')[1] ?? '' }; } });
  keychainSignIns.write(grant);
  assert.deepEqual(keychainSignIns.read(), grant);
  assert.ok(kept.every(call => !call.args.join(' ').includes('access-1') && !call.args.join(' ').includes('refresh-1')), 'no argument carries the sign-in');
  assert.ok(kept[0].args.includes('-i') && kept[0].input.includes(settings.grant.keychain_item));
});

test('the credential: TRILLION_KEY, the kept key, else the kept sign-in, renewed before it ends', async () => {
  const store = { read: () => null, where: 'k' };
  assert.equal((await credentialFor({ env: { TRILLION_KEY: KEY }, store, grants: noGrants })).bearer, KEY);
  assert.equal(await credentialFor({ env: {}, store, grants: noGrants }), null);
  let written = null;
  const fake = await fakeDoor({ oauth: (url, raw, request, send) => {
    const asked = new URLSearchParams(raw);
    if (asked.get('grant_type') === 'refresh_token' && asked.get('refresh_token') === 'refresh-1') return send(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 });
    return send(400, { error: 'invalid_grant' });
  } });
  try {
    const grants = { where: 'g', read: () => ({ access_token: 'access-1', refresh_token: 'refresh-1', expires_at_ms: 1000, client_id: 'c1', origin: fake.origin }), write: grant => { written = grant; }, forget: () => {} };
    const renewed = await credentialFor({ env: {}, store, grants, now: () => 990 });
    assert.deepEqual([renewed.kind, renewed.bearer, renewed.origin, written.refresh_token], ['sign-in', 'access-2', fake.origin, 'refresh-2']);
    const ended = { ...grants, read: () => ({ access_token: 'a', refresh_token: 'gone', expires_at_ms: 1, client_id: 'c1', origin: fake.origin }) };
    await assert.rejects(credentialFor({ env: {}, store, grants: ended, now: () => 990 }), error => error.status === 3 && /sign-in to Trillion has ended/.test(error.message));
  } finally { await fake.close(); }
});

test('the door: the Mac app\'s local door for the key when this computer has one, else the public origin; an asked origin wins', () => {
  const local = 'http://127.0.0.1:8788/mcp';
  const atHome = doorFor({ credential: keyCredential, localMcp: local });
  assert.deepEqual([atHome.mcp, atHome.local, atHome.name], [local, true, `the Mac app's local door ${local}`]);
  const away = doorFor({ credential: keyCredential, localMcp: null });
  assert.deepEqual([away.mcp, away.public], [`${settings.origin}/mcp`, true]);
  assert.equal(doorFor({ credential: { kind: 'sign-in', bearer: 'a', origin: 'https://other.test' }, localMcp: local }).mcp, 'https://other.test/mcp', 'a sign-in is used where it was made');
  assert.equal(doorFor({ asked: 'http://127.0.0.1:9', credential: keyCredential, localMcp: local }).mcp, 'http://127.0.0.1:9/mcp');
});

test('the engine road: replies in JSON or events, one request key on every retry, refusals that name the door and never say log in', async () => {
  assert.deepEqual(repliesOf('event: message\ndata: {"id":1}\n\n'), [{ id: 1 }]);
  let busy = 2;
  const fake = await fakeDoor({ sse: true, ops: {
    '@own-records records:list': () => (busy-- > 0 ? { status: 503 } : { records: [] }),
    '@own-records records:read': () => ({ refused: 'That record kind is not readable here.' }),
  } });
  try {
    const client = trillionClient({ door: doorAt(fake.mcp), credential: keyCredential, rules: quick, wait: noWait });
    assert.deepEqual(await client.op('@own-records', 'records:list', { type: 'ai' }, { idempotent: true }), { records: [] });
    const keys = fake.calls.filter(call => call.method === 'records:list').map(call => call.request_key);
    assert.equal(keys.length, 3);
    assert.equal(new Set(keys).size, 1, 'a retry carries the same request key');
    await assert.rejects(client.op('@own-records', 'records:read', { id: 'x' }), /not readable here/);
    // A refused key: the door says which door; at the public door it names this computer's local door.
    const refusedAt = (door, credential = { kind: 'key', bearer: `nm_${'cd'.repeat(32)}`, where: 'k' }) => trillionClient({ door, credential, rules: quick, wait: noWait }).whoami();
    await assert.rejects(refusedAt(doorAt(fake.mcp)), error => error.status === 3 && error.message === `the door ${fake.mcp} refused this computer's credential.`);
    await assert.rejects(refusedAt(doorAt(fake.mcp, { public: true, name: `the public door ${fake.mcp}`, localMcp: 'http://127.0.0.1:8788/mcp' })),
      error => error.message === `the public door ${fake.mcp} does not admit this computer's key yet; the key works at this computer's local door http://127.0.0.1:8788/mcp.` && !/log ?in/i.test(error.message));
    // A route the door does not serve.
    const missing = trillionClient({ door: doorAt(`${fake.origin}/mcp/api/account`), credential: keyCredential, rules: quick, wait: noWait });
    await assert.rejects(missing.whoami(), error => error.message === `the door ${fake.origin}/mcp/api/account does not serve /mcp/api/account.` && !/log ?in/i.test(error.message));
    assert.throws(() => trillionClient({ door: doorAt(fake.mcp), credential: null }), error => error.status === 3 && /Run trillion login/.test(error.message));
  } finally { await fake.close(); }
  const gone = trillionClient({ door: doorAt('http://127.0.0.1:9/mcp'), credential: keyCredential, rules: { ...quick, retry_seconds: [] }, wait: noWait });
  await assert.rejects(gone.whoami(), error => error.status === 4 && /could not be reached/.test(error.message) && !/log ?in/i.test(error.message));
});

test('whoami: the account from MCP initialize, this AI\'s id and facts, and the door that answered', async () => {
  const fake = await fakeDoor();
  try {
    const seams = seamsFor(home(), { localDoor: () => fake.mcp });
    const said = await main(['whoami'], seams);
    assert.equal(said, [`account ${ACCOUNT}`, `ai ai:claude-code-on-${computerOf()}`, 'facts Claude Code, Anthropic, Mac', `door the Mac app's local door ${fake.mcp}`].join('\n'));
    const json = JSON.parse(await main(['whoami', '--json'], seams));
    assert.deepEqual([json.account_id, json.local, json.door, json.app, json.computer], [ACCOUNT, true, fake.mcp, 'Claude Code', 'Mac']);
    assert.ok(!JSON.stringify(json).includes(KEY));
  } finally { await fake.close(); }
});

test('tools: every page of the Workshop list until next is null, and a pager that repeats a page is refused', async () => {
  const pages = { '': { tools: [{ id: 'tool:a', job: 'Does a' }], next: 'p2' }, p2: { tools: [{ id: 'tool:b', job: 'Does b' }], next: 'p3' }, p3: { tools: [{ id: 'tool:c', job: 'Does c' }], next: null } };
  const fake = await fakeDoor({ ops: {
    '@workshop-tools tools:list': input => pages[input.after ?? ''],
    '@workshop-tools tools:run': input => ({ ran: input.tool, with: input.input }),
  } });
  try {
    const seams = seamsFor(home(), { localDoor: () => fake.mcp });
    assert.equal(await main(['tools'], seams), 'tool:a  Does a\ntool:b  Does b\ntool:c  Does c');
    assert.deepEqual(fake.calls.filter(call => call.method === 'tools:list').map(call => call.input), [{}, { after: 'p2' }, { after: 'p3' }]);
    assert.deepEqual(JSON.parse(await main(['call', 'tool:b', '{"x":1}'], seams)), { ran: 'tool:b', with: { x: 1 } });
    await assert.rejects(main(['call', 'tool:b', '[1]'], seams), /one JSON object/);
    const stuck = { op: async () => ({ tools: [{ id: 'tool:a' }], next: 'same' }) };
    await assert.rejects(allPages(stuck, '@workshop-tools', 'tools:list', {}, 'tools'), /answered a page it already gave/);
  } finally { await fake.close(); }
});

// The person's `ai_list` list, whose title field is a formula field (the binding is the engine's; the stand-in below
// answers what it would).
const AI_LIST = { id: 'list:ais', type: 'list', value: { label: 'Your AIs', row_type: 'ai', title_field: 'name', fields: [
  { id: 'name', kind: 'formula', label: 'Name', derive: { request: { binding: { $kind: 'binding', select: { from: 'self', path: [] } } } } }, { id: 'nickname', kind: 'text', label: 'Nickname' }] } };
const nameOf = value => value.nickname ?? [value.app, value.model, value.computer].filter(Boolean).join(' · ');
// tools:run as the engine answers it: the tool's own answer under `result`.
const ran = result => ({ exit_code: 0, replayed: false, result });

test('who: the AIs tool:see-my-ais answers, named by the list:ais formula in one call, grouped by owner with yours first, ready chats beneath, the rest counted', async () => {
  const now = Date.now();
  const recent = new Date(now - 10 * 60_000).toISOString(), earlier = new Date(now - 5 * 3_600_000).toISOString(), old = new Date(now - 10 * 86_400_000).toISOString();
  const codex = { app: 'Codex', model: 'gpt-6.1-sol', computer: 'Studio' };
  const ais = [
    { id: 'ai:codex-1-on-mac', value: { agent_id: 'codex-1-on-mac', ...codex, working_on: 'Review the login page' }, live: true, seen_at: recent, busy: 1 },
    { id: 'ai:sofus', value: { agent_id: 'claude-x', owner: '1234567890abcdef', nickname: 'Sofus\'s research Claude', app: 'Claude Code' }, live: true, seen_at: recent, busy: 0 },
    { id: 'ai:codex-2-on-mac', value: { agent_id: 'codex-2-on-mac', ...codex }, live: false, seen_at: earlier, busy: 0 },
    { id: 'ai:old', value: { agent_id: 'take-open-work-preflight', label: 'take-open-work-preflight', kind: 'account' }, live: false, seen_at: old, busy: 0 },
  ];
  let list = AI_LIST;
  const fake = await fakeDoor({ ops: {
    '@own-records records:read': input => (input.id === 'list:ais' ? list : { id: input.id, value: null }),
    '@workshop-tools tools:run': input => (input.tool === 'tool:see-my-ais' ? ran({ ais })
      : input.tool === 'tool:evaluate-a-formula' ? ran({ values: input.input.rows.map(row => nameOf(row) || null), errors: [] }) : { refused: `no ${input.tool}` }),
  } });
  try {
    const seams = seamsFor(home(), { localDoor: () => fake.mcp });
    const who = (await main(['who'], seams)).split('\n');
    assert.equal(who[0], `Yours (account ${ACCOUNT.slice(0, 8)}…)`);
    assert.match(who[1], /^ {2}Codex · gpt-6\.1-sol · Studio {2}1 of 2 chats ready {2}last seen .+$/);
    assert.equal(who[2], '    ready  ai:codex-1-on-mac  1 taken  working on: Review the login page');
    assert.equal(who[3], 'Account 12345678…', 'another person\'s AI always shows its owner');
    assert.match(who[4], /^ {2}Sofus's research Claude {2}1 of 1 chats ready/, 'a nickname is the AI\'s name');
    assert.equal(who[5], '    ready  ai:sofus');
    assert.equal(who[6], '1 more chats not seen in 3 days; trillion who --all shows them.');
    assert.equal(who.length, 7, 'one line per AI, not one per chat; away chats are counted in their AI\'s line');
    const formulaCalls = fake.calls.filter(call => call.input?.tool === 'tool:evaluate-a-formula');
    assert.equal(formulaCalls.length, 1, 'the names are worked out in one call');
    assert.deepEqual(formulaCalls[0].input.input.binding, AI_LIST.value.fields[0].derive.request.binding, 'the list\'s own formula, as it is stored');
    assert.equal(formulaCalls[0].input.input.rows.length, 3, 'only the AIs shown are named');
    const all = await main(['who', '--all'], seams);
    assert.match(all, /An AI with no app, model or computer recorded \(account\) {2}0 of 1 chats ready/);
    assert.match(all, / {4}away {2}ai:codex-2-on-mac {2}last seen /);
    assert.ok(!all.includes('take-open-work-preflight'), 'an AI\'s own label is never its name');
    const groups = groupsOf(ais.map(row => aiOf(row, { name: nameOf(row.value), now, owner: ACCOUNT })), { you: ACCOUNT });
    assert.deepEqual(groups.map(group => [group.owner, group.mine, group.ais.map(ai => ai.chats.length)]), [[ACCOUNT, true, [2, 1]], ['1234567890abcdef', false, [1]]]);
    assert.equal(aiOf(ais[2], { now }).ready, false, 'liveness is the tool\'s, computed when read');
    assert.equal(render('who', { groups: [], hidden: 0 }), settings.who.none);
    // With no list:ais (or one whose title is not a formula) nothing is named some other way: who says which list is missing.
    for (const missing of [{ id: 'list:ais', value: null }, { ...AI_LIST, value: { ...AI_LIST.value, title_field: 'nickname' } }]) {
      list = missing;
      await assert.rejects(main(['who'], seams), error => error.status === 4 && error.message.includes('list:ais') && !/log ?in/i.test(error.message));
    }
    const client = trillionClient({ door: doorAt(fake.mcp), credential: keyCredential, rules: quick, wait: noWait });
    list = AI_LIST;
    assert.deepEqual(await namesOf(client, []), [], 'no AI shown: nothing to name');
  } finally { await fake.close(); }
  // A Workshop without the work tool says which tool is missing, in plain words, never "log in".
  const bare = await fakeDoor({ ops: { '@workshop-tools tools:run': () => ({ code: 'workshop_tool_unknown' }) } });
  try {
    await assert.rejects(main(['who'], seamsFor(home(), { localDoor: () => bare.mcp })),
      error => error.code === 'workshop_tool_unknown' && error.message === `tool:see-my-ais is not in this account's Workshop yet (the Mac app's local door ${bare.mcp}).`);
  } finally { await bare.close(); }
});

test('send, work, take and every move are one Workshop work tool each; a job another AI moved first is shown, never retried', async () => {
  const job = { id: 'ai-job:k1', status: 'waiting', job: 'Fix the build', from: 'ai:claude-code-on-mac', to: null };
  const writes = [];
  let race = false;
  const tools = {
    'tool:hand-a-job-to-an-ai': input => ({ job_id: `ai-job:${input.key}`, status: 'written', job: { ...job, id: `ai-job:${input.key}`, job: input.job, to: input.to } }),
    'tool:see-ai-work': input => (input.id ? { jobs: [{ ...job, id: input.id, status: 'done', result: 'Built.' }], more: false } : { jobs: [job], more: true }),
    'tool:take-an-ai-job': input => (race ? { taken: null, tried: 1, job_id: 'ai-job:k1', reason: 'changed', job: { ...job, status: 'taken', taker: 'ai:codex-on-mac' } }
      : { taken: { ...job, status: 'taken', taker: input.as }, tried: 1 }),
    'tool:change-an-ai-job': input => (race ? { job_id: input.id, moved: false, from: 'taken', to: null, reason: 'changed', job: { ...job, status: 'done', taker: 'ai:codex-on-mac' } }
      : { job_id: input.id, moved: true, from: 'taken', to: input.action === 'finish' ? 'done' : 'waiting', job: { ...job, status: 'done', result: input.result } }),
  };
  const fake = await fakeDoor({ ops: {
    '@workshop-tools tools:run': input => ran(tools[input.tool](input.input)),
    '@own-records records:read': input => ({ id: input.id, type: 'ai', value: null }),
    '@own-records records:write': input => { writes.push(input.records[0]); return { changed: true, write_count: 1 }; },
  } });
  try {
    const seams = seamsFor(home(), { localDoor: () => fake.mcp });
    const sent = await main(['send', 'any', 'Fix', 'the', 'build', '--key', 'k1'], seams);
    assert.match(sent, /^Sent ai-job:k1\.\nai-job:k1 {2}waiting {2}for any AI {2}from ai:claude-code-on-mac\n {2}job: Fix the build\nAny of your AIs can take it\./);
    assert.deepEqual(fake.calls.find(call => call.method === 'tools:run').input, { tool: 'tool:hand-a-job-to-an-ai', input: { as: `ai:claude-code-on-${computerOf()}`, job: 'Fix the build', key: 'k1', to: null } });
    assert.equal(writes.length, 1, 'sending writes this AI\'s own record once');
    assert.deepEqual([writes[0].id, writes[0].expected, writes[0].value.owner], [`ai:claude-code-on-${computerOf()}`, null, ACCOUNT], 'a new record is written on condition it is absent, its owner the door\'s account');
    assert.equal(await main(['work'], seams), `ai-job:k1  waiting  for any AI  from ai:claude-code-on-mac\n  job: Fix the build\n${settings.words.more_jobs}`);
    assert.equal(await main(['work', 'ai-job:k1'], seams), 'ai-job:k1  done  for any AI  from ai:claude-code-on-mac\n  job: Fix the build\n  result: Built.');
    assert.match(await main(['take'], seams), /^Took ai-job:k1\.\nai-job:k1 {2}taken {2}taken by ai:claude-code-on-/);
    assert.deepEqual(Object.keys(seams.state.held()), [`claude-code-on-${computerOf()} ai-job:k1`], 'the job taken is held here');
    assert.equal(writes.at(-1).value.working_on, 'Fix the build', 'this AI\'s record says what it is working on');
    assert.match(await main(['finish', 'ai-job:k1', 'Built.'], seams), /^ai-job:k1: taken -> done\./);
    assert.deepEqual(seams.state.held(), {}, 'a finished job is let go');
    assert.equal(writes.at(-1).value.working_on, null);
    const sentWithWait = await main(['send', 'any', 'x', '--key', 'k2', '--wait', '5'], seams);
    assert.match(sentWithWait, /^ai-job:k2 {2}done/, '--wait reads the job with tool:see-ai-work until it is finished');
    race = true;
    assert.match(await main(['take'], seams), /^Another AI \(ai:codex-on-mac\) moved ai-job:k1 first\.\nai-job:k1 {2}taken {2}taken by ai:codex-on-mac/);
    assert.match(await main(['finish', 'ai-job:k1', 'Built.'], seams), /^ai-job:k1 was not moved \(changed\); here it is as it now is\.\nai-job:k1 {2}done/);
    const changes = fake.calls.filter(call => call.input?.tool === 'tool:change-an-ai-job');
    assert.equal(changes.length, 2, 'a move another AI made first is reported, never tried again');
  } finally { await fake.close(); }
});

test('publish: this AI\'s own record, written on condition of the value just read, and written again over a change made meanwhile', async () => {
  const stored = { nickname: 'Builder', order: 3, app: 'Old app', live: { minutes: 30 } };
  const writes = [];
  let refusal = { code: 'original_command_conflict' };
  const fake = await fakeDoor({ ops: {
    '@own-records records:read': input => ({ id: input.id, type: 'ai', value: stored }),
    '@own-records records:write': input => {
      writes.push(input.records[0]);
      const refused = refusal;
      refusal = null;
      return refused ?? { changed: true, write_count: 1 };
    },
  } });
  try {
    const seams = seamsFor(home(), { localDoor: () => fake.mcp });
    const dry = JSON.parse(await main(['publish', '--dry-run'], seams));
    assert.equal(writes.length, 0, 'a dry run writes nothing');
    assert.deepEqual([dry.value.nickname, dry.value.order, dry.value.app], ['Builder', 3, 'Claude Code']);
    assert.equal(await main(['publish'], seams), `Wrote ai:claude-code-on-${computerOf()}.`);
    assert.equal(writes.length, 2, 'the engine\'s changed refusal is read and written again');
    for (const write of writes) assert.deepEqual(write.expected, { type: 'ai', value: stored }, 'each write is conditioned on the value read');
    refusal = { refused: 'not allowed' };
    await assert.rejects(main(['publish'], seams), /not allowed/, 'any other refusal is not tried again');
    assert.equal(writes.length, 3);
  } finally { await fake.close(); }
  // At most write_tries writes.
  const client = { whoami: async () => ({ account: ACCOUNT }), op: async (address, method) => {
    if (method === 'records:read') return { value: null };
    const error = Object.assign(new TrillionError('conflict'), { code: 'original_command_conflict' });
    if ((client.tries = (client.tries ?? 0) + 1) < 3) throw error;
    return { changed: true };
  } };
  const context = { me, placeImpl: () => ({}), state: { held: () => ({}) } };
  assert.equal((await publishRecord(client, context)).record.id, me.ai_id);
  assert.equal(client.tries, 3);
});

test('serve: a job taken is run, then finished, given back when its command fails, or said stuck, each with tool:change-an-ai-job', async () => {
  const calls = [];
  const client = { op: async (address, method, input) => { calls.push(input); return ran(input.tool === 'tool:take-an-ai-job' ? { taken: { id: 'ai-job:1', job: 'say hi', status: 'taken' }, tried: 1 } : { moved: true }); } };
  const held = [];
  const state = { hold: (agent, job) => held.push(['hold', job.id]), letGo: (agent, id) => held.push(['let go', id]) };
  for (const [result, action] of [[{ ok: true, output: 'hi' }, 'finish'], [{ ok: false, output: 'failed' }, 'release'], [{ ok: true, output: 'x', stuck: 'Which bank?' }, 'stuck']]) {
    calls.length = 0; held.length = 0;
    assert.equal(await serveOnce({ client, me, command: ['cat'], state, log: () => {}, runImpl: async () => result }), true);
    assert.deepEqual(calls[0], { tool: 'tool:take-an-ai-job', input: { as: me.ai_id } });
    assert.deepEqual([calls.at(-1).tool, calls.at(-1).input.action, calls.at(-1).input.id, calls.at(-1).input.as], ['tool:change-an-ai-job', action, 'ai-job:1', me.ai_id]);
    assert.deepEqual(held, action === 'stuck' ? [['hold', 'ai-job:1']] : [['hold', 'ai-job:1'], ['let go', 'ai-job:1']], 'a stuck job stays held');
  }
  const none = { op: async () => ran({ taken: null, tried: 0 }) };
  assert.equal(await serveOnce({ client: none, me, command: ['cat'], state, log: () => {} }), false);
  assert.equal(await waitFor(async () => 'found', { seconds: 1, sleep: noWait }), 'found');
  assert.equal(await waitFor(async () => null, { seconds: 0, sleep: noWait }), null);
  const workClient = { op: async (address, method, input, options) => ({ address, method, input, options }) };
  assert.deepEqual(await workCall(workClient, 'see', { id: 'ai-job:1' }, { idempotent: true }),
    { address: '@workshop-tools', method: 'tools:run', input: { tool: 'tool:see-ai-work', input: { id: 'ai-job:1' } }, options: { idempotent: true } }, 'an answer with no result is the answer itself');
});

test('login: the browser sign-in with PKCE keeps the sign-in itself, and no key route is asked', async () => {
  const seen = {};
  let challenge = null, redirect = null;
  const fake = await fakeDoor({ bearers: [KEY, 'access-1'],
    oauth: (url, raw, request, send) => {
      seen.paths = [...(seen.paths ?? []), url.pathname];
      if (url.pathname === '/oauth/register') { const body = JSON.parse(raw); redirect = body.redirect_uris[0]; seen.client = body; return send(201, { client_id: 'c1' }); }
      const asked = new URLSearchParams(raw);
      if (asked.get('grant_type') === 'authorization_code') {
        seen.verified = createHash('sha256').update(asked.get('code_verifier')).digest('base64url') === challenge && asked.get('code') === 'code-1';
        return send(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 });
      }
      if (asked.get('token_type_hint') === 'refresh_token') { seen.revoked = asked.get('token'); return send(200, {}); }
      return send(400, { error: 'unexpected' });
    } });
  try {
    const open = async url => {
      const asked = new URL(url);
      challenge = asked.searchParams.get('code_challenge');
      seen.authorize = Object.fromEntries(asked.searchParams);
      const back = await fetch(`${asked.searchParams.get('redirect_uri')}?code=code-1&state=${asked.searchParams.get('state')}`);
      seen.page = await back.text();
    };
    const grant = await signInWithBrowser({ origin: fake.origin, open, say: () => {}, now: () => 1000 });
    assert.deepEqual(grant, { access_token: 'access-1', refresh_token: 'refresh-1', expires_at_ms: 1000 + 3600_000, client_id: 'c1', origin: fake.origin });
    assert.equal(seen.verified, true, 'the code was exchanged with the verifier that matches the challenge');
    assert.equal(seen.authorize.code_challenge_method, 'S256');
    assert.equal(seen.authorize.scope, settings.scope);
    assert.equal(seen.authorize.resource, `${fake.origin}/mcp`);
    assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.equal(seen.client.token_endpoint_auth_method, 'none');
    assert.match(seen.page, /Signed in/);
    assert.ok(seen.paths.every(path => !path.includes('/mcp/api')), 'no key route is asked');

    // Through the command: no key here, so login keeps the sign-in, and the public origin answers as that account.
    const folder = home();
    let kept = null;
    const grants = { where: 'test sign-in', read: () => kept, write: value => { kept = value; }, forget: () => { kept = null; } };
    const state = stateOf({ home: folder });
    const run = argv => main([...argv, '--origin', fake.origin], { store: { read: () => null, where: 'no key' }, grants, state, open, env: {}, localDoor: () => null, computerName: 'Mac', model: null, wait: noWait });
    assert.match(await run(['login']), new RegExp(`^Signed in to Trillion as account ${ACCOUNT}, at the door ${fake.origin}/mcp\\. The sign-in is in test sign-in\\.$`));
    assert.match(await run(['login']), /^Already signed in to Trillion as account/);
    assert.match(await run(['logout']), /^Signed out/);
    assert.equal(seen.revoked, 'refresh-1');
    assert.equal(kept, null);
    assert.equal(await run(['logout']), 'Not signed in; there is nothing to sign out of.');
    const pair = pkce();
    assert.equal(createHash('sha256').update(pair.verifier).digest('base64url'), pair.challenge);
  } finally { await fake.close(); }
});

test('logout never ends or removes the Mac app\'s key', async () => {
  const folder = home();
  const store = keyStore({ home: folder, platform: 'linux' });
  store.write(KEY);
  const said = await main(['logout'], { ...seamsFor(folder), store });
  assert.match(said, /was not made by this program \(the Trillion Mac app keeps it\), so it was left on/);
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
  const link = join(folder, '.local/bin/trillion');
  assert.equal(readlinkSync(link), join(folder, '.trillion/cli/program/trillion.mjs'));
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.ok(installProgram({ home: folder }).every(row => row.outcome === 'unchanged'));

  const skills = installSkills({ home: folder, env: {}, text: 'name: trillion-cli\nbody\n' });
  assert.deepEqual(skills.map(row => [row.app, row.outcome]), [['Claude Code', 'written'], ['Codex', 'written']]);
  assert.equal(readFileSync(join(folder, '.claude/skills/trillion-cli/SKILL.md'), 'utf8'), 'name: trillion-cli\nbody\n');
  assert.ok(installSkills({ home: folder, env: {}, text: 'name: trillion-cli\nbody\n' }).every(row => row.outcome === 'unchanged'));
  assert.equal(installSkills({ home: folder, env: {}, text: 'name: trillion-cli\nnew\n' })[0].outcome, 'updated');
  writeFileSync(join(folder, '.codex/skills/trillion-cli/SKILL.md'), 'name: somebody-else\n');
  assert.equal(installSkills({ home: folder, env: {}, text: 'name: trillion-cli\nnew\n' })[1].outcome, 'refused');
  assert.deepEqual(installSkills({ home: folder, env: { CODEX_HOME: join(folder, 'elsewhere') }, only: ['codex'], text: 'name: trillion-cli\n' }).map(row => row.path), [join(folder, 'elsewhere/skills/trillion-cli/SKILL.md')]);

  const moved = home();
  mkdirSync(join(moved, '.local/bin'), { recursive: true });
  symlinkSync(join(moved, 'a-retired-program-that-is-gone.mjs'), join(moved, '.local/bin/trillion'));
  assert.equal(installProgram({ home: moved }).at(-1).outcome, 'updated', 'a link to another program, even a missing one, is replaced');
  assert.equal(readlinkSync(join(moved, '.local/bin/trillion')), join(moved, '.trillion/cli/program/trillion.mjs'));

  const other = home();
  mkdirSync(join(other, '.local/bin'), { recursive: true });
  writeFileSync(join(other, '.local/bin/trillion'), 'a program of its own');
  assert.equal(installProgram({ home: other }).at(-1).outcome, 'refused');
  assert.equal(readFileSync(join(other, '.local/bin/trillion'), 'utf8'), 'a program of its own');
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
  assert.deepEqual(asked[0].args, ['find-generic-password', '-a', 'trillion:acct_one', '-s', settings.keychain_item, '-w']);
  assert.match(asked[1].input, new RegExp(`^add-generic-password -U -a trillion:acct_one -s ${settings.keychain_item} -w ${A}\\n$`));
  assert.deepEqual(asked[2].args, ['delete-generic-password', '-a', 'trillion:acct_one', '-s', settings.keychain_item]);
  assert.ok(asked.every(call => !call.args.join(' ').includes(A)));
});

test('a refused engine call names the step that refused it: the message ends with the cause the engine answers', async () => {
  const reply = { jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'refused' }],
    structuredContent: { code: 'original_workspace_source_unavailable', outcome: 'unknown', cause: 'src/x.rs:118:36:Error::Invalid#abc' } } };
  const fetchImpl = async () => new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  const client = trillionClient({ door: doorAt('http://127.0.0.1:9/mcp', { local: true }), credential: keyCredential, fetchImpl, rules: quick, wait: noWait });
  await assert.rejects(client.op('@workshop-tools', 'tools:list', {}), error => error.code === 'original_workspace_source_unavailable'
    && error.answer.cause === 'src/x.rs:118:36:Error::Invalid#abc' && /Cause: src\/x\.rs:118:36:Error::Invalid#abc$/.test(error.message));
});
