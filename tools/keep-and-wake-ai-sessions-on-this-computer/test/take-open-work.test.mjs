// The helper part that gets open work done by the person's own AI (harness/take-open-work.mjs): the pure planner picks
// what to start now from the account's open work, the local started records keep a job from ever starting twice, and
// a chat's work goes back only to that chat when it is idle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountCaller, chatOf, eachLine, findChats, limitResetAt, listOpenWork, readPage, plan, restUntil, runPass, startedRecords, tailOf, takerCard, withComputerArgs, withWorkMcp } from '../harness/take-open-work.mjs';
import { runTriage } from '../harness/triage-open-work.mjs';
import settingsFile from '../harness/take-open-work.json' with { type: 'json' };

const NOW = '2026-09-30T10:00:00.000Z';
// Two runs at once, whatever this computer is held to right now (the shipped max_concurrent is the person's own choice).
const settings = { ...settingsFile, max_concurrent: 2, use_ai: 'claude', working_folder: '/work', triage: undefined, work_mcp: undefined };
const job = (id, extra = {}) => ({ handoff_id: id, state: 'open', status: 'open', to_agent: null, input: {}, handed_at: `2026-09-30T0${id.slice(-1)}:00:00.000Z`, hold_until: null, ...extra });
const base = { agents: [], settings, started: new Map(), today: 0, running: 0, chats: new Map(), agent_id: 'take-open-work-mac', computer: 'Mac', now: NOW };
// The programs this file's runs are started with are found here, so no test depends on what this computer has installed.
const located = name => `/fake/bin/${name}`;

test('work handed to nobody is claimed oldest first, up to the free slots, with the chosen AI command from DATA', () => {
  const { start, left } = plan({ ...base, open: [job('h3'), job('h1'), job('h2')] });
  assert.deepEqual(start.map(item => item.handoff_id), ['h1', 'h2']);
  assert.equal(left['no free slot now'], 1);
  const [first] = start;
  assert.equal(first.mode, 'claim');
  assert.equal(first.agent_id, 'take-open-work-mac');
  assert.equal(first.cwd, '/work');
  assert.deepEqual(first.command, ['claude', '-p', first.prompt, '--permission-mode', 'bypassPermissions']);
  assert.match(first.prompt, /take_work with agent_id "take-open-work-mac" and handoff_id "h1"/);
  assert.match(first.prompt, /finish_work with handoff_id "h1"/);
  // The AI that takes the work coordinates it through the Marketplace workflow, between taking and finishing.
  assert.match(first.prompt, /start_workflow with purpose "coordinate-work-with-cheapest-capable-agents", a request_key of "h1"/);
  assert.ok(first.prompt.indexOf('take_work') < first.prompt.indexOf('start_workflow') && first.prompt.indexOf('start_workflow') < first.prompt.indexOf('finish_work'));
});

test('the AI is whichever row use_ai names', () => {
  const { start } = plan({ ...base, settings: { ...settings, use_ai: 'codex' }, open: [job('h1')] });
  assert.equal(start[0].command[0], 'codex');
  assert.equal(start[0].command.at(-1), start[0].prompt);
  assert.throws(() => plan({ ...base, settings: { ...settings, use_ai: 'nobody' }, open: [job('h1')] }), /names no row/);
  assert.throws(() => plan({ ...base, settings: { ...settings, use_ai: undefined }, open: [job('h1')] }), /No AI is chosen on this computer yet/);
});

test('runs alive and the daily cap limit what starts', () => {
  assert.equal(plan({ ...base, running: 1, open: [job('h1'), job('h2')] }).start.length, 1);
  assert.equal(plan({ ...base, running: 2, open: [job('h1')] }).start.length, 0);
  const capped = plan({ ...base, today: settings.daily_cap, open: [job('h1')] });
  assert.equal(capped.start.length, 0);
  assert.equal(capped.left['daily cap reached'], 1);
  assert.equal(plan({ ...base, today: settings.daily_cap - 1, open: [job('h1'), job('h2')] }).start.length, 1);
});

test('never twice: a job started here, one handed to a named agent, one held by another AI, waiting on other work or with something an AI said in the way is left; Trillion\'s own wait is taken', () => {
  const open = [
    job('h1'),
    job('h2', { to_agent: 'someone' }),
    job('h3', { state: 'taken', status: 'taken', hold_until: '2026-09-30T11:00:00.000Z' }),
    job('h4', { status: 'blocked', in_the_way: 'Needs the person to sign in', in_the_way_by: 'some-ai' }),
    job('h7', { status: 'blocked', in_the_way: 'Waiting for any AI', in_the_way_by: 'trillion' }),
    job('h8', { next_step: { kind: 'dependency', on: ['h1'] } }),
    job('h5', { state: 'taken', status: 'taken', hold_until: '2026-09-30T09:00:00.000Z' }),
    job('h6', { state: 'finished', status: 'finished' }),
  ];
  const started = new Map([['h1', { handoff_id: 'h1', mode: 'claim', ended_at: NOW }]]);
  const { start, left } = plan({ ...base, settings: { ...settings, max_concurrent: 10 }, started, open });
  assert.deepEqual(start.map(item => item.handoff_id), ['h5', 'h7']);
  assert.deepEqual(left, { 'already started here': 1, 'handed to a named agent': 1, 'being worked on': 1, 'something is in the way': 1, 'waits for other work': 1 });
});

test('a chat\'s work goes back to that idle chat, one run per chat, and waits when the chat is busy, owned or unknown here', () => {
  const chatSource = 'claude-code:aaaa-1111';
  const from = (id, source_id) => job(id, { input: { arrived: { source_id } } });
  const chats = new Map([[chatSource, { cwd: '/projects/one', idle: true, bytes: 1000 }], ['codex:bbbb', { cwd: '/projects/two', idle: false, bytes: 1000 }], ['codex:huge', { cwd: '/projects/three', idle: true, bytes: settings.chat_largest_bytes + 1 }]]);
  const { start, left } = plan({ ...base, chats, open: [from('h1', chatSource), from('h2', chatSource), from('h3', 'codex:bbbb'), from('h4', 'x-coredata://note/p1'), from('h5', 'codex:owned'), from('h6', 'codex:huge')], agents: [{ agent_id: 'codex-owned', takes_work: true, source_id: 'codex:owned' }] });
  assert.equal(start.length, 1);
  const [run] = start;
  assert.equal(run.mode, 'chat');
  assert.equal(run.agent_id, 'chat-aaaa-1111');
  assert.equal(run.cwd, '/projects/one');
  assert.match(run.prompt, /start_workflow with purpose "coordinate-work-with-cheapest-capable-agents", a request_key of "h1"/);
  assert.deepEqual(run.command, ['claude', '-p', '--resume', 'aaaa-1111', run.prompt, '--permission-mode', 'bypassPermissions']);
  assert.match(run.prompt, /source_id "claude-code:aaaa-1111"/);
  assert.deepEqual(left, { 'its chat is busy': 2, 'waits for its own chat': 2, 'its chat is too long to resume': 1 });
  // A chat already running here is busy until its run ends.
  const busy = plan({ ...base, chats, open: [from('h2', chatSource)], started: new Map([['h1', { handoff_id: 'h1', mode: 'chat', source_id: chatSource }]]) });
  assert.equal(busy.start.length, 0);
});

test('an open handoff named for its source chat resumes that exact idle chat', () => {
  const source_id = 'claude-code:aaaa-1111';
  const owner = 'session-claude-code-aaaa-1111';
  const open = [job('h1', { to_agent: owner, input: { arrived: { source_id, from_person: true } } })];
  const chats = new Map([[source_id, { cwd: '/projects/one', idle: true, bytes: 100 }]]);
  const agents = [{ agent_id: owner, takes_work: true, source_id }];
  const result = plan({ ...base, open, agents, chats });
  assert.deepEqual(result.start.map(item => item.handoff_id), ['h1']);
  assert.equal(result.start[0].mode, 'chat');
  assert.equal(result.start[0].agent_id, owner);
  assert.match(result.start[0].prompt, /session-claude-code-aaaa-1111/);
});

test('a chat file is read a block at a time, never whole: lines across blocks stay whole, and reading stops once found', () => {
  // A long session's file passes the largest string Node can make (512 MB); reading it whole stopped every pass.
  const root = mkdtempSync(join(tmpdir(), 'take-open-work-'));
  const file = join(root, 'long.jsonl');
  const long = 'x'.repeat((1 << 20) + 17);
  writeFileSync(file, `${JSON.stringify({ type: 'meta', pad: long })}\n${JSON.stringify({ cwd: '/work/sample/proj' })}\n${'{"more":1}\n'.repeat(300000)}`);
  const seen = [];
  eachLine(file, line => { seen.push(line.length); return line.includes('cwd'); });
  assert.equal(seen.length, 2, 'stops at the line it needs');
  assert.equal(seen[0], JSON.stringify({ type: 'meta', pad: long }).length, 'a line longer than a block comes back whole');
  let count = 0;
  eachLine(file, () => { count += 1; return false; });
  assert.equal(count, 300003, 'every line, the last empty one included');
  assert.equal(tailOf(file, 11), '{"more":1}\n');
});

test('chat rows find the session file and its working folder, and say whether the chat is idle', () => {
  const root = mkdtempSync(join(tmpdir(), 'take-open-work-'));
  mkdirSync(join(root, 'p', 'proj'), { recursive: true });
  const file = join(root, 'p', 'proj', 'aaaa.jsonl');
  writeFileSync(file, `${JSON.stringify({ type: 'meta' })}\n${JSON.stringify({ cwd: '/work/sample/proj' })}\n`);
  const rows = { ...settings, chats: [{ id: 'c', source_prefix: 'c:', session_file: `${root}/p/*/{session}.jsonl`, working_folder_at: ['cwd'], command: ['x'] }] };
  assert.deepEqual(chatOf(rows, 'c:aaaa').session, 'aaaa');
  const nowMs = Date.parse(NOW);
  utimesSync(file, new Date(nowMs - 2 * 3600_000), new Date(nowMs - 2 * 3600_000));
  const size = statSync(file).size;
  assert.deepEqual(findChats(rows, ['c:aaaa', 'c:none', 'other:1'], nowMs), new Map([['c:aaaa', { cwd: '/work/sample/proj', idle: true, bytes: size }]]));
  utimesSync(file, new Date(nowMs - 60_000), new Date(nowMs - 60_000));
  assert.equal(findChats(rows, ['c:aaaa'], nowMs).get('c:aaaa').idle, false);
});

test('a started record is created once: a second claim of the same handoff is refused', () => {
  const records = startedRecords(mkdtempSync(join(tmpdir(), 'take-open-work-')));
  assert.equal(records.claim({ handoff_id: 'h1', started_at: NOW }), true);
  assert.equal(records.claim({ handoff_id: 'h1', started_at: NOW }), false);
  records.update('h1', { pid: 42 });
  assert.equal(records.all().get('h1').pid, 42);
  records.update('h1', { ended_at: NOW });
  assert.equal(records.rearm('h1'), 2);
  assert.equal(records.all().has('h1'), false);
  assert.equal(records.claim({ handoff_id: 'h1', attempt: 2, started_at: NOW }), true);
});

test('a pass claims by id, starts the AI once, and a second pass starts nothing for the same job', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'take-open-work-'));
  const calls = [];
  let finished = false;
  const call = async (path, body) => {
    calls.push([path, body]);
    if (path === '/handoffs/open-page') return body.after
      ? { work: [job('h1', { state: finished ? 'finished' : 'open' })], agents: [], next_after: null }
      : { work: [job('h2', { to_agent: 'x' })], agents: [], next_after: 'h2' };
    if (path === '/handoffs/take') return { handoff: { handoff_id: body.handoff_id, state: 'taken' } };
    if (path === '/handoffs/read') return { handoff: { handoff_id: body.handoff_id, state: finished ? 'finished' : 'taken', taken_by: 'take-open-work-mac', summary: 'done' } };
    return {};
  };
  const spawned = [];
  const spawnRun = (command, args) => {
    spawned.push([command, ...args]);
    const listeners = {};
    setTimeout(() => { finished = true; listeners.close?.(0); }, 5);
    return { pid: process.pid, on: (name, fn) => { listeners[name] = fn; } };
  };
  const pass = await runPass({ locate: located, settings: { ...settings, state_folder: folder }, call, computer: 'Mac', spawnRun, now: () => new Date(NOW) });
  assert.deepEqual(pass.started, ['h1']);
  assert.deepEqual(await Promise.all(pass.runs), [{ handoff_id: 'h1', code: 0, finished: true }]);
  assert.equal(spawned.length, 1);
  assert.deepEqual(calls.filter(([path]) => path === '/handoffs/take').map(([, body]) => body), [{ agent_id: 'take-open-work-mac', handoff_id: 'h1' }]);
  assert.ok(calls.some(([path, body]) => path === '/agents/publish' && body.agent_id === 'take-open-work-mac' && body.capacity.max_concurrent === settings.max_concurrent));
  finished = false;
  const again = await runPass({ locate: located, settings: { ...settings, state_folder: folder }, call, computer: 'Mac', spawnRun, now: () => new Date(NOW) });
  assert.deepEqual(again.started, []);
  assert.equal(again.left['already started here'], 1);
  assert.equal(spawned.length, 1);
});

test('a run that ends without finishing its claimed job releases it immediately with the reason', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'take-open-work-'));
  const calls = [];
  const call = async (path, body) => {
    calls.push([path, body]);
    if (path === '/handoffs/open-page') return { work: [job('h1')], agents: [], next_after: null };
    if (path === '/handoffs/take') return { handoff: { handoff_id: body.handoff_id } };
    if (path === '/handoffs/read') return { handoff: { handoff_id: body.handoff_id, state: 'taken', taken_by: 'take-open-work-mac' } };
    return {};
  };
  const spawnRun = () => { const listeners = {}; setTimeout(() => listeners.close?.(3), 5); return { pid: process.pid, on: (name, fn) => { listeners[name] = fn; } }; };
  const pass = await runPass({ locate: located, settings: { ...settings, state_folder: folder }, call, computer: 'Mac', spawnRun, now: () => new Date(NOW) });
  await Promise.all(pass.runs);
  const released = calls.find(([path]) => path === '/handoffs/release');
  assert.equal(released[1].agent_id, 'take-open-work-mac');
  assert.match(released[1].because, /exit 3/);
  assert.equal(calls.some(([path]) => path === '/handoffs/in-the-way'), false);
});

test('the work AI receives a keychain-backed Trillion MCP config without the account key', () => {
  const folder = mkdtempSync(join(tmpdir(), 'take-open-work-mcp-'));
  mkdirSync(join(folder, 'runs'));
  const production = { ...settingsFile, state_folder: folder };
  const claude = production.ais.find(row => row.id === 'claude');
  const command = withWorkMcp({ handoff_id: 'h1', ai_id: 'claude', work_mcp: claude.work_mcp }, claude.command, production, folder,
    { runtime: '/app/node', bridge: '/app/harness/keychain-mcp-bridge.mjs' });
  assert.deepEqual(command.slice(0, 4), ['claude', '--mcp-config', join(folder, 'runs', 'h1.mcp.json'), '--strict-mcp-config']);
  const config = readFileSync(join(folder, 'runs', 'h1.mcp.json'), 'utf8');
  assert.deepEqual(JSON.parse(config), { mcpServers: { trillion: { command: '/app/node', args: ['/app/harness/keychain-mcp-bridge.mjs'] } } });
  assert.doesNotMatch(`${command.join(' ')} ${config}`, /nm_[A-Za-z0-9]/);
  const codex = production.ais.find(row => row.id === 'codex');
  const codexCommand = withWorkMcp({ handoff_id: 'h2', ai_id: 'codex', work_mcp: codex.work_mcp }, codex.command, production, folder,
    { runtime: '/app/node', bridge: '/app/harness/keychain-mcp-bridge.mjs' });
  assert.deepEqual(codexCommand.slice(0, 6), ['codex', 'exec', '-c', 'mcp_servers.trillion.command="/app/node"', '-c', 'mcp_servers.trillion.args=["/app/harness/keychain-mcp-bridge.mjs"]']);
});

test('a failed Trillion MCP preflight leaves the job unclaimed and records the runnable AI trouble', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'take-open-work-preflight-'));
  const calls = [];
  const call = async (path, body) => {
    calls.push([path, body]);
    if (path === '/handoffs/open-page') return { work: [job('h1')], agents: [], next_after: null };
    return {};
  };
  const production = { ...settingsFile, max_concurrent: 1, use_ai: 'codex', working_folder: '/work', triage: undefined, state_folder: folder };
  const pass = await runPass({ locate: located, settings: production, call, computer: 'Mac', spawnRun: () => { throw new Error('must not spawn'); },
    checkConnection: async () => { throw new Error('Auth required'); }, now: () => new Date(NOW) });
  assert.deepEqual(pass.started, []);
  assert.equal(calls.some(([path]) => path === '/handoffs/take'), false);
  assert.match(calls.filter(([path]) => path === '/agents/publish').at(-1)[1].description, /MCP preflight failed.*Auth required/);
});

test('a timed out AI releases its claim and gives the next chosen AI a turn', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'take-open-work-timeout-'));
  const calls = [];
  const call = async (path, body) => {
    calls.push([path, body]);
    if (path === '/handoffs/open-page') return { work: [job('h1')], agents: [], next_after: null };
    if (path === '/handoffs/read') return { handoff: { handoff_id: 'h1', state: 'taken', taken_by: 'take-open-work-mac', generation: 1 } };
    return { handoff: { handoff_id: 'h1' } };
  };
  const spawnRun = () => {
    const listeners = {};
    return { pid: process.pid, on: (name, fn) => { listeners[name] = fn; }, kill: () => { listeners.close?.(143); } };
  };
  const pass = await runPass({ locate: located, settings: { ...settings, ai_order: ['codex', 'claude'], use_ai: 'codex', state_folder: folder, run_timeout_minutes: 0.0001 }, call, computer: 'Mac', spawnRun, now: () => new Date(NOW) });
  assert.deepEqual(await Promise.all(pass.runs), [{ handoff_id: 'h1', code: 143, finished: false, timeout: true, released: true }]);
  assert.ok(calls.some(([path]) => path === '/handoffs/release'));
  // A timeout alone does not rest the AI (the account may have been the one failing): why is kept and shown on the card.
  assert.equal(existsSync(join(folder, 'resting.json')), false);
  assert.match(JSON.parse(readFileSync(join(folder, 'trouble.json'), 'utf8')).codex.what, /timed out after/);
  const card = calls.filter(([path]) => path === '/agents/publish').at(-1)[1];
  assert.match(card.description, /timed out after/);
  assert.equal(card.capacity.trouble[0].ai, 'codex');
});

test('a timeout whose words say the usage limit was reached rests the AI until the reset they name, and the card says so', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'take-open-work-timeout-limit-'));
  const calls = [];
  const lines = [];
  const call = async (path, body) => {
    calls.push([path, body]);
    if (path === '/handoffs/open-page') return { work: [job('h1')], agents: [], next_after: null };
    if (path === '/handoffs/read') return { handoff: { handoff_id: 'h1', state: 'taken', taken_by: 'take-open-work-mac', generation: 1 } };
    return { handoff: { handoff_id: 'h1' } };
  };
  const spawnRun = () => {
    const listeners = {};
    writeFileSync(join(folder, 'runs', 'h1.log'), "You've hit your weekly limit · resets Oct 13 at 7am (America/Los_Angeles)\n");
    return { pid: process.pid, on: (name, fn) => { listeners[name] = fn; }, kill: () => { listeners.close?.(143); } };
  };
  mkdirSync(join(folder, 'runs'), { recursive: true });
  const at = new Date('2026-10-08T19:45:00.000Z');
  const pass = await runPass({ locate: located, settings: { ...settings, ai_order: ['claude', 'codex'], use_ai: 'claude', state_folder: folder, run_timeout_minutes: 0.0001 }, call, computer: 'Mac', spawnRun, now: () => at, log: entry => lines.push(entry) });
  await Promise.all(pass.runs);
  assert.equal(JSON.parse(readFileSync(join(folder, 'resting.json'), 'utf8')).claude.until, '2026-10-13T14:00:00.000Z');
  assert.deepEqual(lines.find(entry => entry.did === 'rested'), { did: 'rested', ai: 'claude', until: '2026-10-13T14:00:00.000Z', because: lines.find(entry => entry.did === 'rested').because });
  assert.match(lines.find(entry => entry.did === 'rested').because, /weekly limit/);
  assert.match(calls.find(([path]) => path === '/handoffs/release')[1].because, /rests until 2026-10-13T14:00:00.000Z/);
  const card = calls.filter(([path]) => path === '/agents/publish').at(-1)[1];
  assert.match(card.description, /Claude Code resting until 2026-10-13T14:00:00.000Z because/);
  assert.equal(card.capacity.resting[0].ai, 'claude');
});

test('when every chosen AI rests, the card says so and the first is not silently picked', () => {
  const rested = { ...settings, ai_order: ['codex', 'claude'], resting: { codex: '2026-09-30T12:00:00.000Z', claude: '2026-09-30T13:00:00.000Z' }, resting_because: { codex: 'a', claude: 'b' } };
  const card = takerCard(rested, 'Mac', NOW);
  assert.equal(card.capacity.all_resting, true);
  assert.match(card.description, /Every chosen AI is resting/);
  assert.match(card.description, /Codex resting until 2026-09-30T12:00:00.000Z because a/);
  assert.equal(takerCard({ ...rested, resting: { codex: rested.resting.codex } }, 'Mac', NOW).capacity.all_resting, false);
  assert.equal(takerCard({ ...rested, resting: {} }, 'Mac', NOW).capacity.resting, undefined);
});

test('a program that cannot start gives the job back, does not rest its AI, and is shown on the card', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'take-open-work-nostart-'));
  const calls = [];
  const call = async (path, body) => {
    calls.push([path, body]);
    if (path === '/handoffs/open-page') return { work: [job('h1')], agents: [], next_after: null };
    if (path === '/handoffs/take') return { handoff: { handoff_id: 'h1' } };
    if (path === '/handoffs/read') return { handoff: { handoff_id: 'h1', state: 'taken', taken_by: 'take-open-work-mac', generation: 1 } };
    return {};
  };
  const spawnRun = () => { const listeners = {}; setTimeout(() => { listeners.error?.(new Error('spawn claude ENOENT')); listeners.close?.(-2); }, 5); return { pid: undefined, on: (name, fn) => { listeners[name] = fn; } }; };
  const pass = await runPass({ locate: located, settings: { ...settings, state_folder: folder }, call, computer: 'Mac', spawnRun, now: () => new Date(NOW) });
  const [ended] = await Promise.all(pass.runs);
  assert.equal(ended.started, false);
  assert.equal(existsSync(join(folder, 'resting.json')), false);
  assert.match(calls.find(([path]) => path === '/handoffs/release')[1].because, /could not be started.*ENOENT/);
  assert.match(calls.filter(([path]) => path === '/agents/publish').at(-1)[1].description, /could not start: spawn claude ENOENT/);
});

test('a usage-limit message that names its reset rests until then, in its own time zone; none named rests limit_rest_hours', () => {
  const now = Date.parse('2026-10-08T19:45:00.000Z');
  assert.equal(limitResetAt(settings, "You've hit your weekly limit · resets Oct 13 at 7am (America/Los_Angeles)", now), '2026-10-13T14:00:00.000Z');
  assert.equal(limitResetAt(settings, "You've hit your limit · resets 3:30pm (Europe/London)", now), '2026-10-09T14:30:00.000Z');
  assert.equal(limitResetAt(settings, "resets 7am (America/Los_Angeles)", now), '2026-10-09T14:00:00.000Z', 'already past today: the next such time');
  assert.equal(limitResetAt(settings, "resets Oct 1 at 12am (UTC)", now), '2027-10-01T00:00:00.000Z', 'a date already past is next year\'s');
  assert.equal(limitResetAt(settings, "resets Dec 25 at 12pm (Nowhere/Land)", now), null);
  assert.equal(limitResetAt(settings, "You've hit your weekly limit · resets Oct 6", now), null);
  assert.equal(restUntil(settings, 'usage_limit_reached', now), new Date(now + settings.limit_rest_hours * 3_600_000).toISOString());
  assert.equal(restUntil(settings, "resets Oct 13 at 7am (America/Los_Angeles)", now), '2026-10-13T14:00:00.000Z');
});

test('a Claude settings file kept on this computer is added right after claude in every claude command, and nothing else changes', () => {
  const plain = withComputerArgs(settingsFile, {});
  assert.equal(plain, settingsFile, 'no setting, no change');
  const routed = withComputerArgs(settingsFile, { claude_settings_file: '/p/proxy.json' });
  assert.deepEqual(routed.ais[0].command.slice(0, 3), ['claude', '--settings', '/p/proxy.json']);
  assert.deepEqual(routed.ais[0].command.slice(3), settingsFile.ais[0].command.slice(1));
  assert.deepEqual(routed.ais[1].command, settingsFile.ais[1].command, 'codex is untouched');
  const chat = routed.chats.find(row => row.id === 'claude-code');
  assert.deepEqual(chat.command.slice(0, 3), ['claude', '--settings', '/p/proxy.json']);
  assert.deepEqual(chat.retry_command.slice(0, 3), ['claude', '--settings', '/p/proxy.json']);
  assert.deepEqual(routed.chats.find(row => row.id === 'codex').command, settingsFile.chats.find(row => row.id === 'codex').command);
  const haiku = routed.triage.models.find(row => row.id === 'claude-haiku');
  assert.deepEqual(haiku.command.slice(0, 3), ['claude', '--settings', '/p/proxy.json']);
  assert.ok(haiku.command.includes('--setting-sources'));
  assert.deepEqual(routed.triage.models.find(row => row.id === 'codex-small').command, settingsFile.triage.models.find(row => row.id === 'codex-small').command);
  assert.equal(withComputerArgs(settingsFile, { claude_settings_file: '~/p.json' }).ais[0].command[2], `${homedir()}/p.json`);
  assert.equal(plan({ ...base, settings: routed, open: [job('h1')] }).start[0].command[1], '--settings');
});

test('a job the account will not hand over is recorded and not run', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'take-open-work-'));
  const call = async path => (path === '/handoffs/open-page' ? { work: [job('h1')], agents: [], next_after: null } : path === '/handoffs/take' ? { handoff: null, note: 'h1 is not waiting' } : {});
  let spawned = 0;
  const pass = await runPass({ locate: located, settings: { ...settings, state_folder: folder }, call, computer: 'Mac', spawnRun: () => { spawned += 1; }, now: () => new Date(NOW) });
  assert.deepEqual(pass.started, []);
  assert.equal(spawned, 0);
  assert.equal(startedRecords(folder).all().get('h1').refused, 'h1 is not waiting');
});

test('an answer saying to send again is sent again, and other refusals are not', async () => {
  const real = globalThis.fetch;
  const answers = [[503, { error: 'busy' }, '5'], [200, { ok: true }]];
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push([url, init.headers.authorization]);
    const [status, body, after] = answers.shift();
    return new Response(JSON.stringify(body), { status, headers: after ? { 'retry-after': after } : {} });
  };
  const waited = [];
  try {
    const call = accountCaller('https://example.test/', 'k', { wait: async seconds => { waited.push(seconds); } });
    assert.deepEqual(await call('/handoffs/read', {}), { ok: true });
    assert.deepEqual(waited, [5]);
    assert.deepEqual(seen, [['https://example.test/mcp/api/handoffs/read', 'Bearer k'], ['https://example.test/mcp/api/handoffs/read', 'Bearer k']]);
    answers.push([400, { error: 'No handoff' }]);
    await assert.rejects(call('/handoffs/read', {}), /No handoff/);
  } finally { globalThis.fetch = real; }
});

test('work from a place with no chat is claimed once the account says any AI may take it, and waits before that', () => {
  const note = extra => job('h1', { input: { arrived: { source_id: 'note-17' } }, ...extra });
  assert.equal(plan({ ...base, open: [note({ anyone_from: '2026-09-30T11:00:00.000Z' })] }).left['waits for its own chat'], 1);
  const { start } = plan({ ...base, open: [note({ anyone_from: '2026-09-30T09:00:00.000Z' })] });
  assert.equal(start[0].mode, 'claim');
  assert.equal(start[0].agent_id, 'take-open-work-mac');
});

test('a chat too long to resume, or busy, gives its work to the chosen AI once the chat has had its turn', () => {
  const chats = new Map([['claude-code:s1', { cwd: '/w', idle: true, bytes: settings.chat_largest_bytes + 1 }]]);
  const long = job('h1', { input: { arrived: { source_id: 'claude-code:s1' } }, anyone_from: '2026-09-30T09:00:00.000Z' });
  assert.equal(plan({ ...base, chats, open: [long] }).start[0].mode, 'claim');
  assert.equal(plan({ ...base, chats, open: [{ ...long, anyone_from: '2026-09-30T11:00:00.000Z' }] }).left['its chat is too long to resume'], 1);
  const idleSmall = new Map([['claude-code:s1', { cwd: '/w', idle: true, bytes: 10 }]]);
  assert.equal(plan({ ...base, chats: idleSmall, open: [long] }).start[0].mode, 'chat', 'a chat that can be resumed still gets its own work');
});

test('a busy account is sent again on the backoff from DATA, then given up as busy', async () => {
  const waited = [];
  let sent = 0;
  const busy = () => ({ ok: false, headers: new Headers({ 'retry-after': '1' }), json: async () => ({ error: 'The service was busy for a moment; send this again.' }) });
  const call = accountCaller('https://example.invalid', 'k', { backoff_seconds: settings.busy.backoff_seconds, wait: async seconds => { waited.push(seconds); }, send: async () => { sent += 1; return busy(); } });
  await assert.rejects(call('/handoffs/read', {}), error => error.busy === true);
  assert.deepEqual(waited, settings.busy.backoff_seconds);
  assert.equal(sent, settings.busy.backoff_seconds.length + 1);
  const plain = accountCaller('https://example.invalid', 'k', { wait: async () => {}, send: async () => ({ ok: false, headers: new Headers(), json: async () => ({ error: 'no' }) }) });
  await assert.rejects(plain('/x', {}), error => !error.busy);
});

test('a run stopped while the account is busy gives its job back', async () => {
  const { releaseHeld } = await import('../harness/take-open-work.mjs');
  const calls = [];
  const call = async (path, body) => { calls.push([path, body]); return path === '/handoffs/read' ? { handoff: { state: 'taken', taken_by: 'chat-s1', generation: 3 } } : { handoff: { state: 'open' } }; };
  assert.equal(await releaseHeld(call, settings, { handoff_id: 'h1', agent_id: 'chat-s1' }), true);
  assert.deepEqual(calls[1], ['/handoffs/release', { handoff_id: 'h1', agent_id: 'chat-s1', generation: 3, because: settings.words.released_busy }]);
  assert.equal(await releaseHeld(async () => { throw Object.assign(new Error('busy'), { busy: true }); }, settings, { handoff_id: 'h1', agent_id: 'a' }), false);
});

test('the chosen AIs are tried in the person\'s order, and one resting after its usage limit gives way to the next', async () => {
  const { chosenAi, reachedLimit } = await import('../harness/take-open-work.mjs');
  const ordered = { ...settings, ai_order: ['codex', 'claude'], resting: {} };
  assert.equal(chosenAi(ordered, NOW).id, 'codex');
  assert.equal(chosenAi({ ...ordered, resting: { codex: '2026-09-30T12:00:00.000Z' } }, NOW).id, 'claude');
  assert.equal(chosenAi({ ...ordered, resting: { codex: '2026-09-30T09:00:00.000Z' } }, NOW).id, 'codex', 'a rest that is over ends');
  assert.equal(chosenAi({ ...ordered, resting: { codex: '2026-09-30T12:00:00.000Z', claude: '2026-09-30T12:00:00.000Z' } }, NOW).id, 'codex');
  assert.equal(plan({ ...base, settings: { ...ordered, resting: { codex: '2026-09-30T12:00:00.000Z' } }, open: [job('h1')] }).start[0].ai_id, 'claude');
  assert.equal(reachedLimit(settings, "some output\nYou've hit your weekly limit · resets Oct 6"), true);
  assert.equal(reachedLimit(settings, 'The builders stopped: rate limit reached for claude-opus'), false);
});

test('what the person said themselves goes first and past the daily cap, held only by the free slots, and skips sorting', () => {
  const own = (id, extra = {}) => job(id, { priority: 5, ...extra });
  const capped = plan({ ...base, today: settings.daily_cap, open: [job('h1'), own('h4'), own('h3')] });
  assert.deepEqual(capped.start.map(item => item.handoff_id), ['h4', 'h3'], 'the newest of the person\'s words goes first');
  assert.ok(capped.start.every(item => item.own));
  // A job a rule handed at a low priority for a message the person sent is still their words: ahead of older work at
  // the line, past the cap, and not held for sorting (2026-10-08: a question waited behind 625 older jobs).
  const byRule = job('h6', { priority: 3, input: { arrived: { from_person: true } } });
  const ruled = plan({ ...base, today: settings.daily_cap, settings: { ...settings, max_concurrent: 2, triage: settingsFile.triage }, triaged: new Map(), open: [own('h1'), job('h2'), byRule] });
  assert.deepEqual(ruled.start.map(item => item.handoff_id), ['h6', 'h1']);
  assert.ok(ruled.start.every(item => item.own));
  assert.equal(capped.left['daily cap reached'], 1);
  assert.equal(plan({ ...base, running: settings.max_concurrent, today: settings.daily_cap, open: [own('h3')] }).left['no free slot now'], 1);
  const sorted = plan({ ...base, settings: { ...settings, triage: settingsFile.triage }, triaged: new Map(), open: [job('h1'), own('h2')] });
  assert.deepEqual(sorted.start.map(item => item.handoff_id), ['h2']);
  assert.equal(sorted.left['waits for triage'], 1);
});

test('the helper runs one full pass over waiting work at a time, and one more when asked while one runs', async () => {
  const { passer } = await import('../harness/wake-handlers/take-open-work.mjs');
  let runs = 0;
  let release;
  const pass = passer({ run: () => { runs += 1; return new Promise(done => { release = done; }); } });
  const first = pass();
  pass();
  pass();
  await new Promise(done => setTimeout(done, 0));
  assert.equal(runs, 1);
  release();
  await first;
  await new Promise(done => setTimeout(done, 0));
  assert.equal(runs, 2);
  release();
});

test('one full pass reads the open work once for sorting and taking, a page at a time', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'take-open-work-'));
  const pages = [];
  const call = async (path, body) => {
    if (path === '/handoffs/open-page') { pages.push(body.after); return body.after ? { work: [job('h2')], agents: [{ agent_id: 'second', source_id: 'codex:two', takes_work: true }, { agent_id: 'shared', source_id: 'codex:latest', takes_work: true }], next_after: null } : { work: [job('h1', { to_agent: 'first', input: { arrived: { source_id: 'codex:one' } } })], agents: [{ agent_id: 'first', source_id: 'codex:one', takes_work: true }, { agent_id: 'shared', source_id: 'codex:earlier', takes_work: true }], next_after: 'h1' }; }
    if (path === '/handoffs/read') return { handoff: null };
    return {};
  };
  const listed = await listOpenWork(call);
  assert.deepEqual(listed.work.map(item => item.handoff_id), ['h1', 'h2']);
  assert.deepEqual(listed.agents.map(card => card.agent_id), ['first', 'shared', 'second']);
  assert.equal(listed.agents.find(card => card.agent_id === 'shared').source_id, 'codex:latest');
  assert.deepEqual(pages, [null, 'h1']);
  pages.length = 0;
  await runTriage({ settings: { ...settingsFile, state_folder: folder }, call, computer: 'Mac', ask: async () => null, listed });
  const pass = await runPass({ locate: located, settings: { ...settings, max_concurrent: 0, state_folder: folder }, call, computer: 'Mac', spawnRun: () => {}, now: () => new Date(NOW), listed });
  assert.deepEqual(pass.started, []);
  assert.deepEqual(pages, [], 'sorting and taking read the list the pass already read');
  assert.equal(pass.left['waits for its own chat'], 1, 'the first page source owner remains recognized');
  assert.equal(pass.left['handed to a named agent'], undefined);
  const direct = await runPass({ locate: located, settings: { ...settings, max_concurrent: 0, state_folder: folder }, call, computer: 'Mac', spawnRun: () => {}, now: () => new Date(NOW) });
  assert.deepEqual(pages, [null, 'h1']);
  assert.equal(direct.left['waits for its own chat'], 1, 'direct paging retains the same first page owner');
  assert.equal(direct.left['handed to a named agent'], undefined);
});

test('one announced job is read by its id, never by listing every open job, even when it came from a chat', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'take-open-work-'));
  const calls = [];
  const fromChat = job('h7', { input: { arrived: { source_id: 'codex:abc' } } });
  const call = async (path, body) => {
    calls.push([path, body]);
    if (path === '/handoffs/read') return { handoff: body.handoff_id === 'h7' ? fromChat : job(body.handoff_id) };
    if (path === '/handoffs/open-page') return { work: [job('h1')], agents: [{ agent_id: 'chat-abc', takes_work: true, source_id: 'codex:abc' }], next_after: body.limit === 1 ? 'h1' : null };
    return {};
  };
  const run = (onlyHandoffId, knownAgents = null) => runPass({ locate: located, settings: { ...settings, max_concurrent: 0, state_folder: folder }, call, computer: 'Mac', spawnRun: () => {}, now: () => new Date(NOW), onlyHandoffId, knownAgents });
  await run('h3');
  assert.deepEqual(calls.map(([path]) => path), ['/handoffs/read'], 'a job from no chat is one read');
  calls.length = 0;
  await run('h7');
  assert.deepEqual(calls.map(([path, body]) => [path, body.limit ?? null]), [['/handoffs/read', null], ['/handoffs/open-page', 1]], 'a chat job reads one page, for the agent cards');
  calls.length = 0;
  await run('h7', [{ agent_id: 'chat-abc', takes_work: true, source_id: 'codex:abc' }]);
  assert.deepEqual(calls.map(([path]) => path), ['/handoffs/read'], 'cards the caller already holds are not read again');
});

test('the event pass takes a priority-6 job it read by id as the person\'s own work, not "waits for triage"', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'take-open-work-'));
  const call = async (path, body) => (path === '/handoffs/read' ? { handoff: job(body.handoff_id, { priority: 6 }) } : {});
  const triaged = { ...settings, max_concurrent: 1, triage: settingsFile.triage, state_folder: folder };
  const pass = await runPass({ locate: located, settings: triaged, call, computer: 'Mac', spawnRun: () => {}, now: () => new Date(NOW), onlyHandoffId: 'h4' });
  assert.equal(pass.left['waits for triage'], undefined);
});

test('one failed page read is read again, so a dropped connection does not throw away the walk; a busy answer is not waited on twice', async () => {
  const waits = [];
  const wait = seconds => { waits.push(seconds); return Promise.resolve(); };
  let fails = 2;
  const flaky = async () => { if (fails-- > 0) throw new TypeError('fetch failed'); return { work: [], agents: [], next_after: null }; };
  assert.deepEqual(await readPage(flaky, { limit: 50 }, { backoff_seconds: [2, 5, 15], wait }), { work: [], agents: [], next_after: null });
  assert.deepEqual(waits, [2, 5]);
  waits.length = 0;
  const down = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(readPage(down, {}, { backoff_seconds: [1, 2], wait }), /fetch failed/);
  assert.deepEqual(waits, [1, 2]);
  waits.length = 0;
  await assert.rejects(readPage(async () => { throw Object.assign(new Error('busy'), { busy: true }); }, {}, { backoff_seconds: [1], wait }), /busy/);
  assert.deepEqual(waits, []);
  // The whole walk survives one failure on its second page.
  let second = 0;
  const call = async (path, body) => {
    if (body.after && second++ === 0) throw new TypeError('fetch failed');
    return body.after ? { work: [job('h2')], agents: [], next_after: null } : { work: [job('h1')], agents: [], next_after: 'h1' };
  };
  assert.deepEqual((await listOpenWork(call, { backoff_seconds: [0], wait })).work.map(item => item.handoff_id), ['h1', 'h2']);
});

test('an idle account is looked at less and less often, and new work brings the usual wait back', async () => {
  const { passWait } = await import('../harness/wake-handlers/take-open-work.mjs');
  const wait = passWait({ every_minutes: settingsFile.full_pass_every_minutes, most_minutes: settingsFile.idle_pass_most_minutes });
  const every = settingsFile.full_pass_every_minutes;
  assert.equal(wait.after({ idle: true }), every * 2);
  assert.equal(wait.after({ idle: true }), every * 4);
  for (let pass = 0; pass < 10; pass += 1) wait.after({ idle: true });
  assert.equal(wait.minutes(), settingsFile.idle_pass_most_minutes);
  assert.equal(wait.woken(), every, 'work announced on the stream');
  wait.after({ idle: true });
  assert.equal(wait.after({ idle: false }), every, 'a pass that started or sorted something');
});

test('triage names the Claude model by its family alias, never a dated id', () => {
  const haiku = settingsFile.triage.models.find(row => row.id === 'claude-haiku');
  assert.equal(haiku.command[haiku.command.indexOf('--model') + 1], 'haiku');
});


test('the bridge take-open-work.json names ships beside it, so the packaged Mac helper can start it', () => {
  const settings = JSON.parse(readFileSync(new URL('../harness/take-open-work.json', import.meta.url), 'utf8'));
  assert.ok(existsSync(new URL(settings.work_mcp.bridge, new URL('../harness/take-open-work.mjs', import.meta.url))));
});
