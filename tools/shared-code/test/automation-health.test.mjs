// Ported from old trillion test/automation-health.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. Source health is src/automation-health.mjs here (makeSourceHealth), with its looks in
// tools/run-rules-and-schedules-by-themselves/src/automation-health-looks.json and the formula engine's row filter; the old
// test ran it as the Workshop tool tool:read-source-health (test/engine-tools-for-tests.mjs), which only handed its input to
// readSourceHealth. The six tests of the health itself are the old ones, but for the check that the tool row's shipped
// verify sample holds: that row is only kept (run-rules-and-schedules-by-themselves/from-old-trillion/records/
// workshop-engine-tool-records.json), no running row has it. The four that gathered sources through old
// src/automations.mjs readHealth (with src/inbound.mjs, src/events.mjs and src/messages.mjs over a person's store: computer
// reader evidence, source_health joins and refusals, a note through the one door) are left out: makeAutomations and inbound
// run nowhere (searched makeAutomations, readHealth, inbound( in trillion-workshop tools/, trillion-apps web/, trillion-rust src/).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeSourceHealth } from '../src/automation-health.mjs';
import { makeRowFilter } from '../../formula-engine/rules/filter-rows-by-rules.mjs';
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import looks from '../../run-rules-and-schedules-by-themselves/src/automation-health-looks.json' with { type: 'json' };

const NOW = '2026-09-29T12:00:00.000Z';
const ago = hours => new Date(Date.parse(NOW) - hours * 3600000).toISOString();
const { filterRowsByRules: filterRows } = makeRowFilter({ operators, wasm: () => readFileSync(new URL('../../formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url)) });
const { readSourceHealth } = makeSourceHealth({ looks, filterRows });
const health = input => readSourceHealth({ now: NOW, ...input });

test('a failed connection attempt is visible before listening, while a never-connected or intentionally stopped source stays neutral', async () => {
  const attempt = { source_id: 'events:setup', state: 'failed', problem: 'Insufficient authentication scopes',
    task_id: 'task:proof', retryable: false, next_call: { tool: 'listen_for_events', arguments: { source_id: 'events:setup' } } };
  const sources = [
    { source_id: 'events:setup', kind: 'event-source', connected: false, connection_attempts: [attempt],
      arrived: [{ id: 'recent', at: ago(0.1) }], runs: [{ at: ago(0.1), state: 'completed' }] },
    { source_id: 'events:never', kind: 'event-source', connected: false, connection_attempts: [] },
    { source_id: 'schedule:stopped', kind: 'schedule', connected: false, runs: [{ at: ago(1), state: 'failed', error: 'old failure' }] },
    { source_id: 'events:pending', kind: 'event-source', connected: false, connection_attempts: [{ state: 'working', problem: null, task_id: 'task:pending' }] },
  ];
  const answer = await health({ sources });
  assert.equal(answer.sources[0].state, 'failing');
  assert.equal(answer.sources[0].connected, false, 'reporting the failure never invents a successful subscription');
  assert.match(answer.sources[0].reader_problem, /Insufficient authentication scopes/);
  assert.deepEqual(answer.sources[0].connection_attempts, [attempt]);
  assert.equal(answer.sources[1].state, 'not-connected');
  assert.equal(answer.sources[2].look.label, 'Off');
  assert.equal(answer.sources[3].state, 'not-connected');
  assert.equal(answer.sources[3].reader_problem, null, 'a waiting task is not itself a failed connection');
  sources[0].connection_attempts = [];
  sources[0].connected = true;
  assert.equal((await health({ sources })).sources[0].state, 'healthy', 'fresh owner evidence clears the setup failure');
});

test('each source gets its counts, what the last arrival started, the last error in plain words and the first state whose rules hold', async () => {
  const { sources } = await health({ sources: [
    { source_id: 'carrier:Notes', kind: 'carrier', label: 'Notes', connected: true, arrived: [{ id: 'n1', at: ago(1), title: 'Book the court' }, { id: 'n2', at: ago(30) }, { id: 'n3', at: ago(200) }], rules: [{ rule_id: 'r1', label: 'Hand it to an AI', enabled: true }], runs: [{ at: ago(1), state: 'finished', rule_id: 'r1', arrival_id: 'n1', run_id: 'run:1' }, { at: ago(3), state: 'working', rule_id: 'r1', arrival_id: 'n2' }] },
    { source_id: 'carrier:Memos', kind: 'carrier', label: 'Memos', connected: true, arrived: [{ id: 'm1', at: ago(300) }], runs: [] },
    { source_id: 'events:shop', kind: 'event-source', label: 'Shop', connected: true, arrived: [{ id: 'e1', at: ago(3) }, { id: 'e2', at: ago(2), text: 'Where is my order?' }], rules: [{ rule_id: 'r2', label: 'Answer', enabled: true }], runs: [{ at: ago(3), state: 'completed', arrival_id: 'e1' }, { at: ago(2), state: 'failed', error: 'HTTP 401 Unauthorized from the service', rule_id: 'r2', arrival_id: 'e2', task_id: 't2' }] },
    { source_id: 'events:chat', kind: 'event-source', label: 'Chat', connected: false, arrived: [], runs: [] },
    { source_id: 'schedule:s1', kind: 'schedule', label: 'Weekly check', connected: false, arrived: [{ id: 's1', at: ago(400) }], runs: [] },
    { source_id: 'schedule:s2', kind: 'schedule', label: 'Daily digest', connected: true, arrived: [], runs: [{ at: ago(5), state: 'something new' }] },
  ] });
  const by = Object.fromEntries(sources.map(source => [source.source_id, source]));
  const unauthorized = looks.plain_errors.find(row => row.contains === '401').words;

  assert.equal(by['carrier:Notes'].state, 'healthy');
  assert.deepEqual(by['carrier:Notes'].arrivals, { '24h': 1, '7d': 2 });
  assert.deepEqual(by['carrier:Notes'].last, { at: ago(1), title: 'Book the court' });
  assert.equal(by['carrier:Notes'].nothing_yet, null);
  assert.deepEqual(by['carrier:Notes'].last_started, [{ rule_id: 'r1', rule_label: 'Hand it to an AI', state: 'finished', result: 'succeeded', run_id: 'run:1' }]);
  assert.equal(by['carrier:Notes'].fires, 2);
  assert.deepEqual(by['carrier:Notes'].results, { succeeded: 1, working: 1 });
  assert.deepEqual(by['carrier:Notes'].look, { label: 'Working', tone: 'success' });

  assert.equal(by['carrier:Memos'].state, 'quiet', 'nothing arrived within the carrier window');
  assert.deepEqual(by['carrier:Memos'].last_started, [], 'an arrival no rule started anything for says so');
  assert.equal(by['events:shop'].state, 'failing', 'a failure after the last success');
  assert.deepEqual(by['events:shop'].last, { at: ago(2), title: 'Where is my order?' });
  assert.deepEqual(by['events:shop'].last_started, [{ rule_id: 'r2', rule_label: 'Answer', state: 'failed', result: 'failed', task_id: 't2', error_words: unauthorized }]);
  assert.deepEqual(by['events:shop'].last_error, { words: unauthorized, at: ago(2), rule_id: 'r2', rule_label: 'Answer' });
  assert.equal(by['events:chat'].state, 'not-connected');
  assert.equal(by['events:chat'].nothing_yet, 'Nothing has arrived from Chat yet');
  assert.deepEqual(by['events:chat'].look, { label: 'Not connected', tone: 'neutral' });
  assert.equal(by['schedule:s1'].look.label, 'Off', 'the not-connected words a schedule shows');
  assert.equal(by['schedule:s2'].state, 'nothing-recent', 'a schedule is never quiet, but a run that never finished is not Working either');
  assert.deepEqual(by['schedule:s2'].results, { working: 1 }, 'a run state the looks do not name is never a success');
});

test('a success after a failure clears failing, and a long error is cut', async () => {
  const { sources: [source] } = await health({ sources: [
    { source_id: 'carrier:Mail', kind: 'carrier', label: 'Mail', arrived: [{ id: 'a', at: ago(1) }], runs: [{ at: ago(4), state: 'failed', error: 'x'.repeat(400) }, { at: ago(1), state: 'finished' }] },
  ] });
  assert.equal(source.state, 'healthy');
  assert.equal(source.last_error.words.length, looks.error_words_most, 'a long error is cut to the looks length');
});

test('a run that started and is still going after a failure clears failing: the road works again', async () => {
  const { sources: [source] } = await health({ sources: [
    { source_id: 'carrier:Heard', kind: 'carrier', label: 'Heard', arrived: [{ id: 'a', at: ago(3) }, { id: 'b', at: ago(1) }], runs: [{ at: ago(3), state: 'failed', error: 'does not implement the method "call"', arrival_id: 'a' }, { at: ago(1), state: 'working', arrival_id: 'b' }] },
    { source_id: 'carrier:Still', kind: 'carrier', label: 'Still', arrived: [{ id: 'c', at: ago(1) }], runs: [{ at: ago(4), state: 'working' }, { at: ago(1), state: 'failed', error: 'x', arrival_id: 'c' }] },
  ] });
  assert.equal(source.state, 'healthy', 'one old fault does not keep a source failing while later arrivals are handed on');
  assert.ok(source.last_error, 'the last error is still shown');
  const { sources: [, still] } = await health({ sources: [
    { source_id: 'carrier:Heard', kind: 'carrier', label: 'Heard', arrived: [], runs: [] },
    { source_id: 'carrier:Still', kind: 'carrier', label: 'Still', arrived: [{ id: 'c', at: ago(1) }], runs: [{ at: ago(4), state: 'working' }, { at: ago(1), state: 'failed', error: 'x', arrival_id: 'c' }] },
  ] });
  assert.equal(still.state, 'failing', 'a failure after the last run that worked still fails');
});

test('an error kept as JSON reads as its own words, and one made while Trillion updated says so plainly', async () => {
  const { plainError } = await import('../src/automation-health.mjs');
  assert.equal(plainError('{"error":"The service is down.","phase":"dispatch"}', looks), 'The service is down.');
  assert.equal(plainError({ error: 'The service is down.' }, looks), 'The service is down.');
  assert.equal(plainError('{"error":"The RPC receiver does not implement the method \\"publishedWorkflows\\".","phase":"dispatch"}', looks),
    'Trillion was being updated while this arrived, so nothing was started for it.');
  // A function handed across a binding and called as one (`call`, `apply`, `bind` are a function's own methods) is a
  // fault in Trillion, never an update: worded as one, every workflow's failure since 757cdc06 read as passing.
  assert.equal(plainError('The RPC receiver does not implement the method "call".', looks), 'A fault in Trillion stopped this, so nothing was started for it.');
  assert.equal(plainError('Durable Object reset because its code was updated.', looks),
    'Trillion was being updated while it read this. It reads it again on its next turn.');
  assert.equal(plainError('not json {', looks), 'not json {');
});

test('Working is earned: it needs a recent real arrival or a finished run, never just the absence of a failure', async () => {
  const { sources } = await health({ sources: [
    // The ChatGPT case: connected by an old arrival, no reader, nothing fired, nothing arrived for days.
    { source_id: 'carrier:Chat', kind: 'carrier', label: 'Chat', connected: true, arrived: [{ id: 'a', at: ago(100) }], rules: [], runs: [], readers: [] },
    { source_id: 'carrier:Fresh', kind: 'carrier', label: 'Fresh', connected: true, arrived: [{ id: 'f', at: ago(2) }], rules: [], runs: [], readers: [] },
    // A reader is reported, but nothing has arrived recently.
    { source_id: 'carrier:Read', kind: 'carrier', label: 'Read', connected: true, arrived: [{ id: 'r', at: ago(100) }], rules: [], runs: [],
      readers: [{ route: 'Read', computer: 'Studio Mac', status: 'working', reported_at: ago(0.1), last_read_at: ago(0.1) }] },
    // The Voice Memos case: runs that started long ago and never finished are stuck, not going.
    { source_id: 'carrier:Stuck', kind: 'carrier', label: 'Stuck', connected: true, arrived: [{ id: 's', at: ago(20) }], rules: [], readers: [],
      runs: [{ at: ago(20), state: 'working', arrival_id: 's', run_id: 'run:stuck' }] },
    { source_id: 'schedule:never', kind: 'schedule', label: 'Never ran', connected: true, arrived: [], rules: [], runs: [] },
  ] });
  const by = Object.fromEntries(sources.map(source => [source.source_id, source]));
  assert.equal(by['carrier:Chat'].state, 'no-reader');
  assert.deepEqual(by['carrier:Chat'].look, { label: 'No reader set up', tone: 'warning' });
  assert.match(by['carrier:Chat'].idle_words, /^No reader is set up for Chat\. Nothing has arrived since 2026-09-25 08:00 UTC\.$/);
  assert.equal(by['carrier:Fresh'].state, 'healthy');
  assert.equal(by['carrier:Fresh'].idle_words, null);
  assert.equal(by['carrier:Read'].state, 'nothing-recent');
  assert.match(by['carrier:Read'].idle_words, /^Nothing has arrived since 2026-09-25 08:00 UTC\.$/);
  assert.equal(by['carrier:Stuck'].state, 'failing', 'a run still "working" after the stuck window is a failure');
  assert.equal(by['carrier:Stuck'].last_error.words, looks.stuck_words);
  assert.equal(by['schedule:never'].state, 'nothing-recent');
  assert.equal(by['schedule:never'].idle_words, 'Nothing has arrived yet.');
});
