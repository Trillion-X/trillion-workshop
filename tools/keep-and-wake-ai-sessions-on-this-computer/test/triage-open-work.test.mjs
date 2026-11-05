// The step before a full AI run (harness/triage-open-work.mjs): a cheap model sorts each job this computer may take,
// with what its chat said after it arrived; what is handled is closed, information gathered into one digest, and only
// real work is left for the full run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidates, laterMessages, modelCommand, runModels, runTriage, unread, verdictOf } from '../harness/triage-open-work.mjs';
import { plan, readTriaged } from '../harness/take-open-work.mjs';
import settingsFile from '../harness/take-open-work.json' with { type: 'json' };
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';
import { closeMany } from '../../hand-off-jobs-between-agents/src/close-many.mjs';

const NOW = '2026-09-30T12:00:00.000Z';
// Two runs at once, whatever this computer is held to right now (the shipped max_concurrent is the person's own choice).
const base = { ...settingsFile, max_concurrent: 2, use_ai: 'claude' };

test('sorting prefers the selected AI, retaining its provider configuration with customer tools disabled', async () => {
  const seen = [];
  const ask = runModels({ ...base, use_ai: 'codex' }, '/unused', async (_, __, row) => {
    seen.push(row.id);
    return '{"outcome":"work"}';
  });
  assert.equal(await ask({ system: 's', prompt: 'p' }), '{"outcome":"work"}');
  assert.deepEqual(seen, ['codex-small']);
  const command = settingsFile.triage.models.find(row => row.ai === 'codex').command;
  assert.ok(!command.includes('--ignore-user-config'), 'the configured provider must remain loaded');
  for (const override of ['notify=[]', 'web_search="disabled"']) assert.ok(command.includes(override));
  for (const feature of ['hooks', 'apps', 'plugins', 'shell_tool', 'browser_use', 'computer_use', 'multi_agent', 'multi_agent_v2', 'view_image', 'image_generation', 'code_mode_host', 'sleep_tool', 'goals', 'tool_suggest']) {
    assert.ok(command.some((part, index) => part === '--disable' && command[index + 1] === feature));
  }
  assert.ok(command.includes('--ephemeral'));
  const compiled = modelCommand(settingsFile.triage.models.find(row => row.ai === 'codex'), { system: 's' }, {
    read: () => '[mcp_servers.customer]\nurl="https://example.invalid"\n[plugins."customer-tools"]\nenabled=true\n',
  });
  assert.ok(compiled.includes('mcp_servers.customer.enabled=false'));
  assert.ok(compiled.includes('plugins."customer-tools".enabled=false'));
  assert.throws(() => modelCommand(settingsFile.triage.models.find(row => row.ai === 'codex'), { system: 's' }, {
    read: () => { throw Object.assign(new Error('unreadable configuration'), { code: 'EACCES' }); },
  }), /unreadable configuration/, 'unknown tool configuration fails closed');
});

test('a selected sorting AI with no capacity gives way without saving a false verdict', async () => {
  const seen = [];
  const ask = runModels({ ...base, use_ai: 'codex', ai_order: ['codex', 'claude'] }, '/unused', async (_, __, row) => {
    seen.push(row.id);
    return row.ai === 'codex' ? { none: 'provider has no capacity' } : '{"outcome":"work"}';
  });
  assert.equal(await ask({ system: 's', prompt: 'p' }), '{"outcome":"work"}');
  assert.deepEqual(seen, ['codex-small', 'claude-haiku']);
  assert.equal(ask.why['codex-small'], 'provider has no capacity');
});

test('a chosen AI that fails is never swapped for an AI the person did not choose', async () => {
  const seen = [];
  const ask = runModels({ ...base, use_ai: 'codex', ai_order: ['codex'] }, '/unused', async (_, __, row) => {
    seen.push(row.id);
    return row.ai === 'codex' ? { none: 'provider has no capacity' } : '{"outcome":"work"}';
  });
  assert.equal(await ask({ system: 's', prompt: 'p' }), null);
  assert.deepEqual(seen, ['codex-small']);
});

test('chosen AIs are tried in the order the person gave them, and only those', async () => {
  const seen = [];
  const ask = runModels({ ...base, use_ai: 'claude', ai_order: ['codex', 'claude'] }, '/unused', async (_, __, row) => {
    seen.push(row.id);
    return row.ai === 'codex' ? { none: 'provider has no capacity' } : '{"outcome":"work"}';
  });
  assert.equal(await ask({ system: 's', prompt: 'p' }), '{"outcome":"work"}');
  assert.deepEqual(seen, ['codex-small', 'claude-haiku']);
});

test('with no chosen AI, no model row is asked at all', async () => {
  const seen = [];
  const ask = runModels({ ...base, use_ai: 'claude', ai_order: [] }, '/unused', async (_, __, row) => {
    seen.push(row.id);
    return '{"outcome":"work"}';
  });
  assert.equal(await ask({ system: 's', prompt: 'p' }), null);
  assert.deepEqual(seen, []);
});

test('a job is sorted by the outcome its answer names, and an answer naming none counts as when_unsure', () => {
  assert.deepEqual(verdictOf(base, 'Sure: {"outcome": "handled", "reason": "The chat fixed it an hour later."}'), { outcome: 'handled', then: 'close', reason: 'The chat fixed it an hour later.', meaning: null, understood: true });
  assert.equal(verdictOf(base, '{"outcome": "information", "reason": "A status note."}').then, 'digest');
  assert.equal(verdictOf(base, 'no idea').outcome, base.triage.when_unsure);
  assert.equal(verdictOf(base, '{"outcome": "shrug"}').then, 'take');
});

test('only work this computer may take now is sorted: not named, not held, and past its chat\'s turn with no chat of its own', () => {
  const job = (id, extra = {}) => ({ handoff_id: id, state: 'open', to_agent: null, input: {}, handed_at: `2026-09-30T0${id.slice(-1)}:00:00.000Z`, ...extra });
  const open = [
    job('h1'),
    job('h2', { to_agent: 'someone' }),
    job('h3', { input: { arrived: { source_id: 'note-1' } }, anyone_from: '2026-09-30T13:00:00.000Z' }),
    job('h4', { input: { arrived: { source_id: 'note-2' } }, anyone_from: '2026-09-30T11:00:00.000Z' }),
    job('h5', { input: { arrived: { source_id: 'chat-x' } }, anyone_from: '2026-09-30T11:00:00.000Z' }),
    job('h6', { state: 'taken', hold_until: '2026-09-30T13:00:00.000Z' }),
    job('h7'),
  ];
  const agents = [{ agent_id: 'x', takes_work: true, source_id: 'chat-x' }];
  const found = candidates({ open, agents, settings: base, triaged: new Map([['h7', {}]]), started: new Set(), now: NOW });
  assert.deepEqual(found.map(item => item.handoff_id), ['h1', 'h4']);
});

test('what the chat said after the job arrived is read from its transcript, and nothing from before', () => {
  const root = mkdtempSync(join(tmpdir(), 'triage-'));
  mkdirSync(join(root, 'p'), { recursive: true });
  writeFileSync(join(root, 'p', 's1.jsonl'), [
    { timestamp: '2026-09-30T08:00:00.000Z', type: 'user', message: { content: 'before' } },
    { timestamp: '2026-09-30T09:30:00.000Z', type: 'assistant', message: { content: [{ type: 'text', text: 'Done: I fixed the sidebar.' }, { type: 'tool_use', name: 'Edit' }] } },
    { timestamp: '2026-09-30T09:40:00.000Z', type: 'attachment' },
  ].map(row => JSON.stringify(row)).join('\n'));
  const settings = { ...base, chats: base.chats.map(row => (row.id === 'claude-code' ? { ...row, session_file: `${root}/*/{session}.jsonl` } : row)) };
  const later = laterMessages(settings, { input: { arrived: { source_id: 'claude-code:s1', at: '2026-09-30T09:00:00.000Z' } } });
  assert.equal(later, 'assistant: Done: I fixed the sidebar.');
  assert.equal(laterMessages(settings, { input: { arrived: { source_id: 'note-1' } } }), '');
});

test('a pass closes what is handled, gathers information into one digest, and leaves only real work for the full run', async () => {
  const state = mkdtempSync(join(tmpdir(), 'triage-state-'));
  const settings = { ...base, state_folder: state };
  const agents = makeAgents({ store: agentStoreForTests(), now: () => new Date(NOW) });
  const ids = ['done already', 'just a status', 'please build it'].map((job, index) => agents.handOff({ job, request_key: `k${index}` }).handoff.handoff_id);
  const calls = [];
  const call = async (path, body) => {
    calls.push(path);
    if (path === '/handoffs/open-page') return { work: agents.board({ limit: 50 }).work.filter(item => item.state !== 'finished'), agents: [], next_after: null };
    if (path === '/handoffs/close-many') return closeMany({ agents, engine: null, admit: null }, body);
    return agents.read(body);
  };
  const answers = { 'done already': '{"outcome":"handled","reason":"Already done."}', 'just a status': '{"outcome":"information","reason":"A status."}', 'please build it': '{"outcome":"work","reason":"Asks for a build."}' };
  const ask = async ({ prompt }) => answers[Object.keys(answers).find(job => prompt.includes(job))];
  const result = await runTriage({ settings, call, computer: 'Mac', ask, now: () => new Date(NOW) });
  assert.deepEqual(result.sorted, { handled: 1, information: 1, work: 1 });
  assert.deepEqual(result.problems, []);
  assert.equal(agents.read({ handoff_id: ids[0] }).handoff.state, 'finished');
  assert.equal(calls.filter(path => path === '/handoffs/close-many').length, 1, 'everything to close goes in one call');
  const [digest] = result.digests;
  assert.equal(agents.read({ handoff_id: ids[1] }).handoff.result.into, digest.into);
  assert.equal(agents.read({ handoff_id: digest.into }).handoff.input.arrived.count, 1);
  const open = agents.board({ limit: 50 }).work.filter(item => item.state !== 'finished');
  const planned = plan({ open, agents: [], settings, started: new Map(), today: 0, running: 0, chats: new Map(), agent_id: 'a', computer: 'Mac', now: NOW, triaged: readTriaged(state) });
  assert.deepEqual(new Set(planned.start.map(job => job.handoff_id)), new Set([ids[2], digest.into]), 'the job sorted as work runs, and so does the digest, which is never sorted again');
  assert.deepEqual((await runTriage({ settings, call, computer: 'Mac', ask: async () => '{"outcome":"information","reason":"x"}', now: () => new Date(NOW) })).sorted, {}, 'a second pass has nothing new to sort');
});

test('a model that answers nothing sorts nothing: no verdict is kept, and the pass stops asking it', async () => {
  const state = mkdtempSync(join(tmpdir(), 'triage-silent-'));
  const settings = { ...base, state_folder: state };
  const agents = makeAgents({ store: agentStoreForTests(), now: () => new Date(NOW) });
  for (let i = 0; i < 12; i += 1) agents.handOff({ job: `job ${i}`, request_key: `k${i}` });
  let asked = 0;
  const call = async (path, body) => (path === '/handoffs/open-page' ? { work: agents.board({ limit: 50 }).work, agents: [], next_after: null } : agents.read(body));
  const result = await runTriage({ settings, call, computer: 'Mac', ask: async () => { asked += 1; return null; }, now: () => new Date(NOW) });
  assert.deepEqual(result.sorted, {});
  assert.equal(result.unsorted, 12);
  assert.equal(asked, settings.triage.at_once, 'one silent batch and it stops');
  assert.equal(readTriaged(state).size, 0);
});

test('a failed exact job read keeps sorting retryable', async () => {
  const state = mkdtempSync(join(tmpdir(), 'triage-read-failed-'));
  const settings = { ...base, state_folder: state };
  const agents = makeAgents({ store: agentStoreForTests(), now: () => new Date(NOW) });
  const id = agents.handOff({ job: 'Calculate 7 times 8', request_key: 'read-failed' }).handoff.handoff_id;
  let reads = 0;
  const call = async (path, body) => {
    if (path === '/handoffs/open-page') throw new Error('exact job should not scan open work');
    if (path === '/handoffs/read' && ++reads === 2) throw new Error('account temporarily busy');
    return agents.read(body);
  };
  await assert.rejects(runTriage({ settings, call, computer: 'Mac', onlyHandoffId: id, now: () => new Date(NOW) }), /account temporarily busy/);
  assert.equal(readTriaged(state).size, 0);
});

test('a model row that keeps answering nothing gives way to the next row for the rest of the pass', async () => {
  const { runModels } = await import('../harness/triage-open-work.mjs');
  const settings = { ...base, triage: { ...base.triage, give_up_after: 2, models: [{ id: 'first', ai: 'claude' }, { id: 'second', ai: 'claude' }] } };
  const asked = [];
  const ask = runModels(settings, '/tmp', async (_, __, row) => { asked.push(row.id); return row.id === 'first' ? null : '{"outcome":"work"}'; });
  for (let i = 0; i < 4; i += 1) assert.equal(await ask({ system: 's', prompt: 'p' }), '{"outcome":"work"}');
  assert.deepEqual(asked, ['first', 'second', 'first', 'second', 'second', 'second']);
});

test('a job is sorted by the file it points at, and a job sorted to the full run before that is sorted once more', async () => {
  const state = mkdtempSync(join(tmpdir(), 'triage-attached-'));
  const settings = { ...base, state_folder: state };
  const agents = makeAgents({ store: agentStoreForTests(), now: () => new Date(NOW) });
  // Two jobs with the same standing words, told apart only by the words in the file each points at.
  const recording = (name, request_key) => agents.handOff({ job: 'Work through my recording: read all of it and turn it into work.', request_key, input: { arrived: { context: { audio_file: `/R/${name}.mp4`, transcript_file: `/R/${name} transcript.txt` } } } }).handoff.handoff_id;
  const casual = recording('golf', 'k-golf');
  const idea = recording('idea', 'k-idea');
  const plain = agents.handOff({ job: 'please build it', request_key: 'k-plain' }).handoff.handoff_id;
  const files = { '/R/golf transcript.txt': 'Good shot. Do you want to play more holes?', '/R/idea transcript.txt': 'Note to self: build the spin-the-globe game for Morgan this week.' };
  const read = async name => (files[name] ? { encoding: 'utf-8', content: files[name] } : { encoding: 'base64', content: 'AAAA' });
  const call = async (path, body) => {
    if (path === '/handoffs/open-page') return { work: agents.board({ limit: 50 }).work.filter(item => item.state !== 'finished'), agents: [], next_after: null };
    if (path === '/handoffs/close-many') return closeMany({ agents, engine: null, admit: null }, body);
    return agents.read(body);
  };
  const seen = [];
  const ask = async ({ prompt }) => { seen.push(prompt); return prompt.includes('play more holes') ? '{"outcome":"information","reason":"Golf chatter."}' : '{"outcome":"work","reason":"Asks for work."}'; };
  // The earlier sort, made without the files, sent all three to the full run.
  mkdirSync(join(state, 'triaged'), { recursive: true });
  for (const id of [casual, idea, plain]) writeFileSync(join(state, 'triaged', `${id}.json`), JSON.stringify({ handoff_id: id, outcome: 'work', then: 'take', at: NOW }));
  const result = await runTriage({ settings, call, computer: 'Mac', ask, read, now: () => new Date(NOW) });
  assert.deepEqual(result.sorted, { information: 1, work: 2 }, 'recordings and the plain job are sorted again because each now carries its own words');
  assert.ok(seen.some(prompt => prompt.includes('Good shot.')), 'the model is given the words in the file');
  assert.equal(agents.read({ handoff_id: casual }).handoff.state, 'finished', 'the chatter is gathered, not left for a full run');
  assert.equal(agents.read({ handoff_id: idea }).handoff.state, 'open');
  const records = readTriaged(state);
  assert.ok([casual, idea, plain].every(id => unread(settings, records.get(id)).length === 0), 'each is marked as read in full so it is never sorted a third time');
  assert.deepEqual((await runTriage({ settings, call, computer: 'Mac', ask, read, now: () => new Date(NOW) })).sorted, {});
});

test('a job is sorted by the person\'s own words it shows, and one sorted to the full run without them is sorted once more', async () => {
  const state = mkdtempSync(join(tmpdir(), 'triage-said-'));
  const settings = { ...base, state_folder: state };
  const agents = makeAgents({ store: agentStoreForTests(), now: () => new Date(NOW) });
  // Two jobs with the same standing words, told apart only by what the person wrote.
  const standing = 'Do two things with what the person said: turn it into content, or reach out to people.';
  const passing = agents.handOff({ job: standing, said: 'I will be there Friday', request_key: 'k-friday', input: { said: 'I will be there Friday' } }).handoff.handoff_id;
  const ask_ = agents.handOff({ job: standing, said: 'Book the court for Morgan and me on Saturday', request_key: 'k-court' }).handoff.handoff_id;
  const bare = agents.handOff({ job: 'please build it', request_key: 'k-bare' }).handoff.handoff_id;
  const call = async (path, body) => {
    if (path === '/handoffs/open-page') return { work: agents.board({ limit: 50 }).work.filter(item => item.state !== 'finished'), agents: [], next_after: null };
    if (path === '/handoffs/close-many') return closeMany({ agents, engine: null, admit: null }, body);
    return agents.read(body);
  };
  const seen = [];
  const ask = async ({ prompt }) => { seen.push(prompt); return prompt.includes('there Friday') ? '{"outcome":"information","reason":"A reply in passing."}' : '{"outcome":"work","reason":"Asks for a booking."}'; };
  // The earlier sort, made before the sorter read the person's words, sent all three to the full run.
  mkdirSync(join(state, 'triaged'), { recursive: true });
  for (const id of [passing, ask_, bare]) writeFileSync(join(state, 'triaged', `${id}.json`), JSON.stringify({ handoff_id: id, outcome: 'work', then: 'take', at: NOW, attached_read: true }));
  const result = await runTriage({ settings, call, computer: 'Mac', ask, now: () => new Date(NOW) });
  assert.deepEqual(result.sorted, { information: 1, work: 2 }, 'all three jobs now carry words and are sorted once more');
  assert.ok(seen.every(prompt => prompt.includes('<said>')) && seen.some(prompt => prompt.includes('Book the court')), 'the model is given the person\'s words');
  assert.equal(agents.read({ handoff_id: passing }).handoff.state, 'finished', 'the reply in passing is gathered, not left for a full run');
  assert.equal(agents.read({ handoff_id: ask_ }).handoff.state, 'open');
  const records = readTriaged(state);
  assert.ok([passing, ask_, bare].every(id => unread(settings, records.get(id)).length === 0));
  assert.deepEqual((await runTriage({ settings, call, computer: 'Mac', ask, now: () => new Date(NOW) })).sorted, {});
});

test('a pass that stops for want of an answer logs why each model row gave none', async () => {
  const state = mkdtempSync(join(tmpdir(), 'triage-why-'));
  const settings = { ...base, state_folder: state, triage: { ...base.triage, models: [{ id: 'first', ai: 'claude' }, { id: 'second', ai: 'claude' }] } };
  const agents = makeAgents({ store: agentStoreForTests(), now: () => new Date(NOW) });
  agents.handOff({ job: 'please build it', request_key: 'k-why' });
  const call = async (path, body) => (path === '/handoffs/open-page' ? { work: agents.board({ limit: 50 }).work, agents: [], next_after: null } : agents.read(body));
  const ask = runModels(settings, state, async (_, __, row) => ({ none: row.id === 'first' ? 'exit 1: You have hit your weekly limit' : 'ran out of time' }));
  const logged = [];
  await runTriage({ settings, call, computer: 'Mac', ask, log: entry => logged.push(entry), now: () => new Date(NOW) });
  assert.deepEqual(logged.find(entry => entry.did === 'model gave no answer').why, { first: 'exit 1: You have hit your weekly limit', second: 'ran out of time' });
});
