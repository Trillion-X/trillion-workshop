// test/wake-stopped-chats.test.mjs
// harness/wake-handlers/wake-stopped-chats.mjs against transcripts written the way Claude Code and Codex write them:
// a chat cut off mid-turn, stopped by a usage limit or an error is handed out once after it has been quiet; a finished
// chat, one the person interrupted, one still moving, a headless program run and a limit not yet reset are left
// alone; a stopped lane is its own job unless a newer transcript of the same lane carried it on; a refused hand-out
// is tried again on the next check and an accepted one never twice.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, findStops, handOffOf, readRules } from '../harness/wake-handlers/wake-stopped-chats.mjs';
import { anyoneFrom } from '../../shared-code/src/agents.mjs';

const NOW = Date.parse('2026-10-04T20:00:00Z');
const OLD = NOW - 60 * 60_000;
const session = n => `0000000${n}-aaaa-4bbb-8ccc-dddddddddddd`;

// Temp folders live under the work folder's .test-tmp (never /tmp) and are removed by done().
const testRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '.test-tmp');

function world() {
  mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(join(testRoot, 'wake-stopped-'));
  const base = readRules();
  const rules = {
    ...base,
    state_file: join(root, 'woken.json'),
    stuck_file: join(root, 'stuck-chats.json'),
    chats: [{ ...base.chats[0], transcripts: [join(root, 'claude'), '*', '*.jsonl'], live: { ...base.chats[0].live, files: [join(root, 'sessions'), '*.json'] } },{ ...base.chats[1], transcripts: [join(root, 'codex'), '*', 'rollout-*.jsonl'] }],
  };
  const write = (path, rows, mtime = OLD) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    utimesSync(path, mtime / 1000, mtime / 1000);
  };
  const claude = (n, rows, mtime) => write(join(root, 'claude', 'proj', `${session(n)}.jsonl`), [{ type: 'user', entrypoint: 'cli', message: { content: 'start' }, timestamp: '2026-10-04T18:00:00Z' }, ...rows], mtime);
  // One live status file per running process, as Claude Code writes them under ~/.claude/sessions.
  const liveFile = (name, row) => {
    mkdirSync(join(root, 'sessions'), { recursive: true });
    writeFileSync(join(root, 'sessions', `${name}.json`), JSON.stringify(row));
  };
  return { root, rules, write, claude, liveFile, done: () => rmSync(root, { recursive: true, force: true }) };
}

const finished = { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }, timestamp: '2026-10-04T18:30:00Z' };
const cutOff = { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] }, timestamp: '2026-10-04T18:40:00Z' };

test('a chat cut off mid-turn, a usage limit past its reset and a service error are handed out; finished, interrupted, moving and headless chats are not', () => {
  const w = world();
  try {
    w.claude(1, [cutOff]);
    w.claude(2, [finished]);
    w.claude(3, [{ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] }, timestamp: '2026-10-04T18:41:00Z' }]);
    // Still moving: its last turn row is recent too (the quiet clock reads turn rows, not mtime alone).
    w.claude(4, [{ ...cutOff, timestamp: '2026-10-04T19:55:00Z' }], NOW - 5 * 60_000);
    w.claude(5, [{ type: 'assistant', error: 'rate_limit', quotaLimits: { resetsAt: (NOW - 10 * 60_000) / 1000 }, message: { stop_reason: 'stop_sequence' }, timestamp: '2026-10-04T18:50:00Z' }]);
    w.claude(6, [{ type: 'assistant', error: 'rate_limit', quotaLimits: { resetsAt: (NOW + 60 * 60_000) / 1000 }, message: { stop_reason: 'stop_sequence' }, timestamp: '2026-10-04T18:51:00Z' }]);
    w.claude(7, [{ type: 'assistant', isApiErrorMessage: true, message: { stop_reason: 'stop_sequence' }, timestamp: '2026-10-04T18:52:00Z' }]);
    w.write(join(w.root, 'claude', 'proj', `${session(8)}.jsonl`), [{ type: 'user', entrypoint: 'sdk-cli', message: { content: 'a program' } }, cutOff]);
    const found = findStops(w.rules, { now: NOW });
    assert.deepEqual(found.map(stop => [stop.source_id.slice('claude-code:'.length, 'claude-code:'.length + 8), stop.reason]).sort(), [
      ['00000001', 'being cut off before its turn finished'],
      ['00000005', 'a usage limit'],
      ['00000007', 'an error from the AI service'],
    ]);
  } finally { w.done(); }
});

test('a Codex chat is judged by its turn events, its usage limit waits, and each stop gets its own key', () => {
  const w = world();
  try {
    const file = n => join(w.root, 'codex', '04', `rollout-2026-10-04T18-00-00-${session(n)}.jsonl`);
    w.write(file(1), [{ timestamp: '2026-10-04T18:00:00Z', type: 'event_msg', payload: { type: 'task_started' } }, { timestamp: '2026-10-04T18:05:00Z', type: 'event_msg', payload: { type: 'token_count' } }]);
    w.write(file(2), [{ timestamp: '2026-10-04T18:00:00Z', type: 'event_msg', payload: { type: 'task_complete' } }]);
    w.write(file(3), [{ timestamp: '2026-10-04T19:30:00Z', type: 'event_msg', payload: { type: 'task_complete', error: { codex_error_info: 'usage_limit_exceeded' } } }]);
    const found = findStops(w.rules, { now: NOW });
    assert.deepEqual(found.map(stop => stop.key), [`wake-stopped:codex:${session(1)}::2026-10-04T18:00:00Z`]);
    assert.equal(findStops(w.rules, { now: NOW + 2 * 3_600_000 }).some(stop => stop.reason === 'a usage limit'), true);
  } finally { w.done(); }
});

test('stopped lanes are their own jobs, named in the chat job; a lane carried on by a newer transcript is left alone', () => {
  const w = world();
  try {
    w.claude(1, [cutOff]);
    const lanes = join(w.root, 'claude', 'proj', session(1), 'subagents');
    w.write(join(lanes, 'agent-akeeps-running-197909a25af7a48d.jsonl'), [{ type: 'user', isSidechain: true, message: { content: 'Lane brief: keep things running' } }, cutOff]);
    w.write(join(lanes, 'agent-adone-lane-0123456789abcdef.jsonl'), [{ type: 'user', message: { content: 'brief' } }, finished]);
    w.write(join(lanes, 'agent-amoved-0123456789abcdef.jsonl'), [{ type: 'user', message: { content: 'old brief' } }, cutOff], OLD - 60_000);
    w.write(join(w.root, 'claude', 'proj', session(2), 'subagents', 'agent-amoved-fedcba9876543210.jsonl'), [{ type: 'user', message: { content: 'new brief' } }, cutOff], OLD);
    w.claude(2, [finished]);
    const found = findStops(w.rules, { now: NOW });
    const lane = found.find(stop => stop.lane === 'keeps-running');
    assert.equal(lane.first_prompt, 'Lane brief: keep things running');
    assert.equal(found.some(stop => stop.lane === 'done-lane'), false);
    assert.deepEqual(found.filter(stop => stop.lane === 'moved').map(stop => stop.source_id), [`claude-code:${session(2)}`]);
    const chat = found.find(stop => stop.source_id === `claude-code:${session(1)}` && !stop.lane);
    const body = handOffOf(chat, w.rules, { hosted: [{ source_id: chat.source_id, agent_id: 'session-x' }] });
    assert.match(body.job, /keeps-running/);
    assert.equal(body.to_agent, 'session-x');
    assert.deepEqual(body.input, { arrived: { source_id: chat.source_id, chat_silence_minutes: 0 } });
    // A chat not hosted here goes to no AI by name and keeps no silence window: any AI may take it at once.
    const unhosted = handOffOf(chat, w.rules);
    assert.equal(unhosted.to_agent, undefined);
    assert.equal(anyoneFrom({ input: unhosted.input, handed_at: new Date(NOW).toISOString(), source_active_at: new Date(NOW).toISOString() }), new Date(NOW).toISOString());
    const laneBody = handOffOf(lane, w.rules);
    assert.match(laneBody.job, /Lane brief: keep things running/);
    assert.equal(laneBody.once_per, lane.key);
  } finally { w.done(); }
});

test('a refused hand-out is tried on the next check; an accepted one is never handed out twice', async () => {
  const w = world();
  try {
    w.claude(1, [cutOff]);
    let refuse = true;
    const calls = [];
    const call = async (path, body) => { calls.push(body); if (refuse) throw new Error('busy'); return { handoff: { handoff_id: 'h_1' } }; };
    const first = await check({ call, rules: w.rules, now: NOW });
    assert.equal(first.refused.length, 1);
    refuse = false;
    const second = await check({ call, rules: w.rules, now: NOW + 60_000 });
    assert.deepEqual(second.handed.map(row => row.handoff_id), ['h_1']);
    const third = await check({ call, rules: w.rules, now: NOW + 120_000 });
    assert.equal(third.found, 0);
    assert.equal(calls.length, 2);
  } finally { w.done(); }
});

const queue = (operation, content) => ({ type: 'queue-operation', operation, content, timestamp: '2026-10-04T19:50:00Z' });
const liveRow = (n, fields) => ({ pid: process.pid, sessionId: session(n), kind: 'bg', status: 'busy', statusUpdatedAt: NOW - 60_000, ...fields });
const stuckFor = minutes => ({ status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: NOW - minutes * 60_000 });

test('a chat whose last turn is 30 minutes old is a stop though queued messages keep its file fresh, and its queued messages are counted', () => {
  const w = world();
  try {
    w.claude(9, [{ ...cutOff, timestamp: '2026-10-04T19:30:00Z' }, queue('enqueue', 'first'), queue('enqueue', 'second'), queue('remove', 'first')], NOW - 60_000);
    const found = findStops(w.rules, { now: NOW });
    assert.equal(found.length, 1);
    assert.equal(found[0].source_id, `claude-code:${session(9)}`);
    assert.equal(found[0].reason, 'being cut off before its turn finished');
    assert.equal(found[0].queued_messages, 1);
  } finally { w.done(); }
});

test('a live session that is busy is never handed out, whatever its transcript says', () => {
  const w = world();
  try {
    w.claude(1, [cutOff]);
    w.liveFile(session(1), liveRow(1, { status: 'busy' }));
    assert.equal(findStops(w.rules, { now: NOW }).length, 0);
  } finally { w.done(); }
});

test('a live session waiting on a prompt nobody can answer for 4 minutes is a stuck stop, with no AI preferred', () => {
  const w = world();
  try {
    w.claude(1, [cutOff]);
    w.liveFile(session(1), liveRow(1, stuckFor(4)));
    const found = findStops(w.rules, { now: NOW });
    assert.equal(found.length, 1);
    assert.equal(found[0].stuck, true);
    assert.equal(found[0].key, `wake-stopped:claude-code:${session(1)}::stuck:${new Date(NOW - 4 * 60_000).toISOString()}`);
    const body = handOffOf(found[0], w.rules, { hosted: [{ source_id: found[0].source_id, agent_id: 'session-x' }] });
    assert.equal(body.to_agent, undefined);
    assert.equal(body.target, undefined);
    assert.match(body.job, /permission prompt/);
  } finally { w.done(); }
});

test('the same prompt waiting for only 2 minutes is not handed out yet', () => {
  const w = world();
  try {
    w.claude(1, [cutOff]);
    w.liveFile(session(1), liveRow(1, stuckFor(2)));
    assert.equal(findStops(w.rules, { now: NOW }).length, 0);
  } finally { w.done(); }
});

test('a live file whose pid is dead falls back to the transcript rules', () => {
  const w = world();
  try {
    w.claude(1, [cutOff]);
    w.liveFile(session(1), liveRow(1, { pid: 999999, status: 'busy' }));
    const found = findStops(w.rules, { now: NOW });
    assert.equal(found.length, 1);
    assert.equal(found[0].stuck, undefined);
    assert.equal(found[0].reason, 'being cut off before its turn finished');
  } finally { w.done(); }
});

test('each check writes the stuck-chats file with every stop it found, its state, queued count and handoff', async () => {
  const w = world();
  try {
    w.claude(1, [cutOff, queue('enqueue', 'a'), queue('enqueue', 'b'), queue('remove', 'a')]);
    w.liveFile(session(1), liveRow(1, stuckFor(4)));
    w.claude(2, [cutOff]);
    const result = await check({ call: async () => ({ handoff: { handoff_id: 'h_x' } }), rules: w.rules, now: NOW });
    assert.equal(result.handed.length, 2);
    const file = JSON.parse(readFileSync(w.rules.stuck_file, 'utf8'));
    assert.equal(file.checked_at, new Date(NOW).toISOString());
    assert.deepEqual(file.chats, result.stuck);
    assert.deepEqual(file.chats.map(row => [row.source_id, row.state, row.queued_messages, row.handoff_id]).sort(), [
      [`claude-code:${session(1)}`, 'stuck', 1, 'h_x'],
      [`claude-code:${session(2)}`, 'stopped', 0, 'h_x'],
    ]);
  } finally { w.done(); }
});

test('a stuck hand-out is also recorded under the transcript key an older copy uses, so that copy never hands out a second job', async () => {
  const w = world();
  try {
    w.claude(1, [cutOff]);
    w.liveFile(session(1), liveRow(1, stuckFor(4)));
    const result = await check({ call: async () => ({ handoff: { handoff_id: 'h_c' } }), rules: w.rules, now: NOW });
    assert.equal(result.handed.length, 1);
    const woken = JSON.parse(readFileSync(w.rules.state_file, 'utf8'));
    // The older copy: no live block, quiet 0, reading the same state file.
    const older = { ...w.rules, quiet_minutes: 0, chats: w.rules.chats.map(chat => ({ ...chat, live: undefined })) };
    assert.equal(findStops(older, { now: NOW }).length, 1, 'without the record the older copy would hand it out again');
    assert.deepEqual(findStops(older, { now: NOW, woken }).filter(stop => stop.source_id === `claude-code:${session(1)}`), []);
  } finally { w.done(); }
});
