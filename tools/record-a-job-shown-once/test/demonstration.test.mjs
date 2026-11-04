// tools/record-a-job-shown-once/test/demonstration.test.mjs (moved from Trillion test/demonstration.test.mjs)
// "Show me once": a bounded recording of what the person does becomes a draft workflow (F-0190).
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { draftFromEvents, makeDemonstrationTools } from '../read-data/demonstration.mjs';

const events = [
  { event: 'click', app: 'Mail', role: 'AXButton', title: 'Compose', at: 1 },
  { event: 'key', app: 'Mail', text: 'H', key_code: 4, at: 2 }, { event: 'key', app: 'Mail', text: 'i', key_code: 34, at: 2.1 },
  { event: 'chord', app: 'Mail', text: 'return', modifiers: ['command'], key_code: 36, at: 3 },
  { event: 'right_click', app: 'Finder', role: 'AXRow', at: 4 },
];

test('events become ordered steps in words: typing folded, secrets never present, extra steps dropped and said', () => {
  const draft = draftFromEvents(events, undefined, { secrets: 3 });
  assert.deepEqual(draft.steps.map(step => step.do), [
    'In Mail, click "Compose" (button).', 'In Mail, type: Hi', 'In Mail, press command+return.', 'In Finder, right-click the row.',
    'In Finder, type the secret the person supplies (it was not recorded).']);
  assert.ok(draft.steps.every(step => step.id && step.submit?.required));
  const cut = draftFromEvents(Array.from({ length: 70 }, (_, i) => ({ event: 'click', app: 'A', title: `b${i}` })));
  assert.equal(cut.steps.length, 60);
  assert.equal(cut.dropped_steps, 10);
  console.log('readback draft:', JSON.stringify(draft.steps.map(step => step.do)));
});

test('the tool bounds the recording, refuses a missing Mac permission as its own state, and an empty recording asks to try again', async () => {
  const asked = [];
  const tools = makeDemonstrationTools({ record: async request => { asked.push(request); return { events, ended: 'stop_key', secrets_skipped: 0 }; } });
  const answer = await tools.record({ seconds: 9999 });
  assert.equal(asked[0].seconds, 300);
  assert.equal(asked[0].max_events, 400);
  assert.equal(answer.ended, 'stop_key');
  assert.match(answer.said, /stop key/);
  assert.equal(answer.draft.steps.length, 4);
  await assert.rejects(makeDemonstrationTools({ record: async () => ({ events: [], ended: 'needs_input_monitoring' }) }).record({}), error => { assert.equal(error.reaction, 'ask_user'); assert.match(error.message, /Input Monitoring/); return true; });
  await assert.rejects(makeDemonstrationTools({ record: async () => ({ events: [], ended: 'time', secrets_skipped: 0 }) }).record({}), error => error.reaction === 'retry' && /Nothing was recorded/.test(error.message));
});

test('the real Swift recorder starts, is listen only, and reports its own state', { skip: process.platform !== 'darwin' }, () => {
  const out = JSON.parse(execFileSync('/usr/bin/swift', [fileURLToPath(new URL('../do-work/demonstration-recorder.swift', import.meta.url))], { input: JSON.stringify({ seconds: 1, max_events: 5 }), stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf8', timeout: 60000 }));
  assert.ok(['time', 'needs_input_monitoring', 'stop_key', 'most_events'].includes(out.ended));
  assert.equal(typeof out.ax_trusted, 'boolean');
  console.log('readback real recorder:', JSON.stringify({ ended: out.ended, ax_trusted: out.ax_trusted, events_recorded: out.events.length }));
});
