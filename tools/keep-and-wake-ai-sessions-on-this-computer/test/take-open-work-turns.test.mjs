// Turns (harness/take-open-work.mjs, take-open-work.json `turns` and each chat row's `turn`): a task whose source names a
// chat carries the person's words, as they are, to that chat's AI on the computer that holds it, and the AI's reply is the
// task's result. A new chat is started on request. No AI is named in the program: every case below is read from the rows.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finishTurn, plan, readOut, runPass, turnOf } from '../harness/take-open-work.mjs';
import settingsFile from '../harness/take-open-work.json' with { type: 'json' };

const NOW = '2026-11-21T11:00:00.000Z';
const settings = { ...settingsFile, max_concurrent: 4, use_ai: 'claude', working_folder: '/work', triage: undefined, work_mcp: undefined };
const ME = 'ai:take-open-work-server';
const task = (id, ref, extra = {}) => ({ handoff_id: id, task: true, state: 'open', status: 'To do', assignees: [], priority: 'medium',
  sent_at: NOW, sent_by: 'person:someone', input: {}, description: 'hello there', source: { kind: 'chat', ref }, handed_at: NOW, hold_until: null, ...extra });
const base = { agents: [], settings, started: new Map(), today: 0, running: 0, chats: new Map(), agent_id: ME, computer: 'server', now: NOW };
const here = (ref, extra = {}) => new Map([[ref, { cwd: '/home/j/project', idle: false, quiet: true, bytes: 100, ...extra }]]);
const rowOf = id => settings.chats.find(row => row.id === id);

test('a turn to a chat on this computer resumes it with the words, as they are, on standard input', () => {
  const words = '--help me with "this" {session} {prompt} {words} ünïcode';
  const ref = `${rowOf('claude-code').source_prefix}abc-123`;
  const { start } = plan({ ...base, open: [task('t1', ref, { description: words })], chats: here(ref) });
  assert.equal(start.length, 1);
  const [job] = start;
  assert.equal(job.mode, 'turn');
  assert.equal(job.cwd, '/home/j/project');
  assert.equal(job.stdin, words);
  assert.deepEqual(job.command, rowOf('claude-code').turn.resume.map(part => part.replace('{session}', 'abc-123')));
  assert.ok(!job.command.includes(words), 'the words are never an argument');
});

test('a turn waits when its chat is on another computer, busy with its own run, or written to just now', () => {
  const ref = `${rowOf('codex').source_prefix}s-1`;
  assert.equal(plan({ ...base, open: [task('t1', ref)] }).left['waits for its own chat'], 1);
  const busy = new Map([['old', { handoff_id: 'old', mode: 'turn', source_id: ref, started_at: NOW }]]);
  assert.equal(plan({ ...base, open: [task('t1', ref)], chats: here(ref), started: busy }).left['its chat is busy'], 1);
  assert.equal(plan({ ...base, open: [task('t1', ref)], chats: here(ref, { quiet: false }) }).left['its chat is busy'], 1);
  // Two turns to one chat in one pass: the second waits for the first.
  const both = plan({ ...base, open: [task('t1', ref), task('t2', ref)], chats: here(ref) });
  assert.deepEqual(both.start.map(job => job.handoff_id), ['t1']);
  assert.equal(both.left['its chat is busy'], 1);
});

test('a new chat starts with the row\'s start command: a minted id where the row mints one, none where the run names it', () => {
  const claude = plan({ ...base, open: [task('t1', `${rowOf('claude-code').source_prefix}new`)] }).start[0];
  assert.match(claude.session, /^[0-9a-f-]{36}$/);
  assert.ok(claude.command.includes(claude.session));
  assert.equal(claude.fresh, true);
  const codex = plan({ ...base, open: [task('t2', `${rowOf('codex').source_prefix}new`)] }).start[0];
  assert.equal(codex.session, '');
  assert.deepEqual(codex.command, rowOf('codex').turn.start);
  // Two new chats of one kind start side by side: a new chat is busy with nothing yet.
  assert.equal(plan({ ...base, open: [task('a', 'codex:new'), task('b', 'codex:new')] }).start.length, 2);
});

test('a turn nobody can talk to, whose AI is not installed, or that says nothing, waits with words', () => {
  assert.equal(plan({ ...base, open: [task('t1', 'grok:new')] }).left['no chat row says how to talk to it'], 1);
  assert.equal(plan({ ...base, open: [task('t1', 'codex:new')], runnable: () => false }).left['its AI is not installed here'], 1);
  assert.equal(plan({ ...base, open: [task('t1', 'codex:new', { description: '  ', outcome: undefined, title: undefined })] }).left['the turn says nothing'], 1);
});

test('a turn handed to nobody is taken where its chat is; other work handed to nobody is still left; a turn for someone else is left', () => {
  const unassigned = { ...settings, tasks: { ...settings.tasks, take_unassigned: false } };
  const ref = 'claude-code:abc';
  const plain = { ...task('p1', ref), source: undefined };
  const { start, left } = plan({ ...base, settings: unassigned, open: [task('t1', ref), plain], chats: here(ref) });
  assert.deepEqual(start.map(job => job.handoff_id), ['t1']);
  assert.equal(left['handed to nobody'], 1);
  assert.equal(plan({ ...base, open: [task('t2', ref, { assignees: ['ai:someone-else'] })], chats: here(ref) }).left['handed to a named agent'], 1);
  assert.equal(turnOf(settings, plain), null);
  assert.equal(turnOf(settings, { ...task('x', ref), source: { kind: 'repository', ref } }), null);
});

test('readOut reads all of standard output, or the first or last JSON line whose fields match, and nothing when none does', () => {
  assert.equal(readOut({ from: 'stdout' }, '  pong\n'), 'pong');
  assert.equal(readOut({ from: 'stdout' }, ' \n'), null);
  const lines = [
    '{"type":"thread.started","thread_id":"th-9"}', 'not json', '{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}', '{"type":"item.completed","item":{"type":"agent_message","text":"last"}}'].join('\n');
  const reply = rowOf('codex').turn.reply;
  assert.equal(readOut(reply, lines), 'last');
  assert.equal(readOut({ ...reply, last: false }, lines), 'first');
  assert.equal(readOut(rowOf('codex').turn.session, lines), 'th-9');
  assert.equal(readOut(reply, '{"type":"turn.completed"}'), null);
  assert.equal(readOut({ from: 'elsewhere' }, 'x'), null);
});

test('finishTurn writes the exact reply with where to continue, and refuses a run that said nothing', async () => {
  const calls = [];
  const call = async (path, body) => { calls.push({ path, body }); return {}; };
  const job = { handoff_id: 't1', agent_id: ME, taken_at: NOW, source_id: 'codex:new', fresh: true, session: '' };
  const out = '{"type":"thread.started","thread_id":"th-7"}\n{"type":"item.completed","item":{"type":"agent_message","text":"Hi there"}}\n';
  const read = { description: 'hello', outcome: undefined, title: 'hello', obligations: [] };
  assert.equal(await finishTurn(call, settings, { job, read, out, outPath: '/o', logPath: '/l', computer: 'server', at: new Date(NOW) }), null);
  const finishes = () => calls.filter(entry => entry.path === '/handoffs/finish');
  assert.deepEqual(calls.map(entry => entry.path), ['/handoffs/answer', '/handoffs/plan', '/handoffs/finish'], 'answer, acceptance, then finish');
  assert.deepEqual(JSON.parse(finishes()[0].body.result), { reply: 'Hi there', in: 'codex:th-7', to: ME, on: 'server', ai: 'codex' });
  assert.deepEqual(calls[0].body.answer, JSON.parse(finishes()[0].body.result));
  assert.equal(finishes()[0].body.check.outcome, 'hello', 'the check names the outcome the task asked for');
  assert.equal(finishes()[0].body.check.checked_at, NOW);
  assert.equal(finishes()[0].body.check.evidence[0].ref, 'server:/o');
  assert.match(await finishTurn(call, settings, { job, read: { ...read, obligations: [{ id: 'a', outcome: 'b' }] }, out, outPath: '/o', logPath: '/l', computer: 'server' }), /no parts to check/);
  await finishTurn(call, settings, { job: { ...job, source_id: 'claude-code:new', session: 'u-1' }, read, out: 'ok', outPath: '/o', logPath: '/l', computer: 'server' });
  assert.equal(JSON.parse(finishes()[1].body.result).in, 'claude-code:u-1');
  await finishTurn(call, settings, { job: { ...job, source_id: 'claude-code:abc', fresh: false }, read, out: 'again', outPath: '/o', logPath: '/l', computer: 'server' });
  assert.equal(JSON.parse(finishes()[2].body.result).in, 'claude-code:abc');
  assert.match(await finishTurn(call, settings, { job, read, out: '', outPath: '/o', logPath: '/the/log', computer: 'server' }), /said nothing back.*\/the\/log/);
  assert.equal(finishes().length, 3);
});

test('a pass takes a turn, gives the AI the words on standard input, and finishes the task with its reply', async () => {
  const folder = tempFolder(join(tmpdir(), 'take-open-work-turns-'));
  let state = 'open';
  const calls = [];
  const item = task('calendar-task:t9', 'claude-code:new', { assignees: [ME] });
  const call = Object.assign(async (path, body) => {
    calls.push({ path, body });
    if (path === '/handoffs/open-page') return { work: [{ ...item, state }], agents: [], next_after: null };
    if (path === '/handoffs/take') { state = 'taken'; return { handoff: { ...item, state, taken_by: ME, taken_at: NOW } }; }
    if (path === '/handoffs/read') return { handoff: { ...item, state, taken_by: ME, taken_at: NOW } };
    if (path === '/handoffs/finish') { state = 'finished'; return {}; }
    return {};
  }, { tasks: true });
  let given = null;
  const spawnRun = (program, args, options) => {
    writeSync(options.stdio[1], 'Hello from the server\n');
    const listeners = {};
    setTimeout(() => listeners.close?.(0), 5);
    return { pid: process.pid, stdin: { on() {}, end: words => { given = words; } }, on: (name, fn) => { listeners[name] = fn; } };
  };
  const pass = await runPass({ locate: name => `/fake/bin/${name}`, settings: { ...settings, state_folder: folder }, call, computer: 'server', spawnRun, now: () => new Date(NOW) });
  const [ran] = await Promise.all(pass.runs);
  assert.equal(given, 'hello there');
  assert.equal(ran.finished, true);
  const finish = calls.find(entry => entry.path === '/handoffs/finish');
  const result = JSON.parse(finish.body.result);
  assert.equal(result.reply, 'Hello from the server');
  assert.match(result.in, /^claude-code:[0-9a-f-]{36}$/);
  assert.equal(result.to, ME);
  assert.ok(readFileSync(join(folder, 'runs', `${encodeURIComponent('calendar-task:t9')}.out`), 'utf8').includes('Hello'));
});

// The whole product of the axes this planner could branch on (gauntlet 4.4b), run through the real plan(): every case
// keeps the same invariants, whatever the AI row, session, taker, busyness, installation or words.
test('every combination of chat row, session place, taker, busyness, installation and words keeps the turn invariants', () => {
  const rows = [...settings.chats.map(row => row.source_prefix), 'tomorrows-ai:'];
  const sessions = ['new', 'here', 'elsewhere'];
  const takers = [[], [ME], ['ai:other']];
  const busyness = ['free', 'own-run', 'just-written', 'too-long'];
  const installed = [true, false];
  const wordsList = ['hi', '-x --flag', '{session}{prompt}{words}', 'x'.repeat(20000), '', 'emoji 🙂 RTL ‮'];
  let cases = 0;
  for (const prefix of rows) for (const session of sessions) for (const assignees of takers) for (const busy of busyness)
    for (const isInstalled of installed) for (const words of wordsList) {
      cases += 1;
      const ref = `${prefix}${session === 'new' ? 'new' : 's-1'}`;
      const chats = session === 'here' ? here(ref, { quiet: busy !== 'just-written', bytes: busy === 'too-long' ? settings.chat_largest_bytes + 1 : 10 }) : new Map();
      const started = busy === 'own-run' ? new Map([['r', { handoff_id: 'r', mode: 'turn', source_id: ref, started_at: NOW }]]) : new Map();
      const { start, left } = plan({ ...base, open: [task('t', ref, { assignees, description: words })], chats, started, runnable: () => isInstalled });
      const why = Object.keys(left);
      const row = settings.chats.find(chat => ref.startsWith(chat.source_prefix));
      // A row with a session file finds its chat by that file; a row without one finds it where the turn is handed.
      const handed = !(assignees.length && !assignees.includes(ME));
      const placed = row?.session_file ? session === 'here' && busy === 'free' : session !== 'new' && assignees.includes(ME) && busy !== 'own-run';
      const mayRun = row?.turn && words.trim() && isInstalled && handed && (session === 'new' || placed);
      assert.equal(start.length, mayRun ? 1 : 0, `case ${prefix}${session} ${assignees} ${busy} ${isInstalled} ${words.slice(0, 10)}: ${why}`);
      if (!mayRun) { assert.equal(why.length, 1, 'a turn that waits says why, in one reason'); continue; }
      const [job] = start;
      // The words arrive as they are: on standard input, or as the one argument after `--` (never where a dash is a flag).
      if (job.stdin !== undefined) {
        assert.equal(job.stdin, words);
        assert.ok(!job.command.some(part => part.includes(words) && words.length > 3), 'words on standard input are never an argument too');
      } else {
        assert.equal(job.command[job.command.indexOf('--') + 1], words);
        assert.equal(job.command.filter(part => part === words).length, 1);
        assert.ok(job.command.indexOf('--') > 0, 'an argument that carries words follows --');
      }
      assert.equal(job.command[0], row.turn[session === 'new' ? 'start' : 'resume'][0], 'the program is the row\'s own');
    }
  assert.equal(cases, rows.length * 3 * 3 * 4 * 2 * 6);
});
