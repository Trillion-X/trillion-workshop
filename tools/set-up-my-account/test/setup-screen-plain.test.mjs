// The setup screen speaks plainly and says one thing: a person sees the same description everywhere (the guide screen and
// the locked hold read one builder) and none of the internals the customer's own screenshots showed on 2026-10-08 -- a
// database error, AI client and agent names, their computer's name, their account handle, "release owner" and the
// vendors' policy wording. A failed read is "still being set up" and never flips a step between views.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getStartedFacts } from '../read-data/get-started-screen.mjs';
import { setupSteps } from '../read-data/setup-steps.mjs';
import { plainWords } from '../read-data/setup-checks.mjs';
import policy from '../read-data/setup-policy.json' with { type: 'json' };
import setupSettings from '../read-data/setup-steps.json' with { type: 'json' };
import { pendingSetup, provenSetup } from './setup-fixtures.mjs';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const COMPUTER = 'Brians-MacBook-Pro-7';
const HANDLE = 'Avery_handle99';

// Exactly what the customer's screenshots (17.22.37 and 17.22.48) showed beside the plain words.
const INTERNALS = [
  /SQLITE_LOCKED/i, /database table/i, /claude-code/i, /codex-mcp-client/i, /Trillion drive keeper/i,
  new RegExp(COMPUTER, 'i'), new RegExp(HANDLE, 'i'), /release owner/i, /TestFlight/i, /\bApple (?:did|does|has|records|recorded)/i,
  /record-move/i,
];

const leaking = () => {
  const input = pendingSetup();
  input.runtime = { ...input.runtime, components: [
    { id: 'defaults', state: 'ready', ready: true, evidence: {} },
    { id: 'timed_work', state: 'blocked', ready: false, evidence: { failed: [{ id: 'record-move', error: 'SQLITE_LOCKED: database table is locked' }] } },
    { id: 'event_intake', state: 'ready', ready: true, evidence: { sources: [{ label: 'Gmail', state: 'listening' }] } },
    { id: 'agents', state: 'blocked', ready: false, evidence: { agents: [
      { name: 'claude-code', takes_work: false }, { name: 'codex-mcp-client', takes_work: false }, { name: 'Trillion drive keeper', takes_work: false },
    ] } },
  ] };
  return {
    ...input, aiConnected: true, aiApps: ['claude-code', 'codex-mcp-client'],
    devices: [{ id: 'iphone', title: 'iPhone', installed: false, reason: 'Apple has not confirmed TestFlight beta access. Ask the release owner.' }],
    computers: [{ computer_id: 'c1', name: COMPUTER, reported_at: '2026-10-08T11:00:00Z', sources: [] }],
    owned: { profile: { name: 'Avery', handle: HANDLE }, connections: [], pursuits: [] },
    setup_access: [{ source_id: 'testflight', state: 'blocked', blocker: 'policy-missing', reason: 'The release owner has not set this up. Apple records the invitation.' }],
    now: NOW,
  };
};

const screenOf = input => getStartedFacts({ ...setupSteps(input), origin: 'https://app.gettrillion.ai' });

test('the setup screen shows none of the internals from the customer screenshots', () => {
  const screen = screenOf(leaking());
  const drawn = JSON.stringify(screen);
  for (const internal of INTERNALS) assert.doesNotMatch(drawn, internal, String(internal));
  assert.equal(screen.title, 'What Trillion is using');
  assert.ok(screen.sections.some(section => section.id === 'setup-steps' && section.heading === setupSettings.words.steps_heading));
});

test('what the person is shown: no app access section, no continuation, no stop, no devices block, no AI-doable step', () => {
  const sections = screenOf(leaking()).sections;
  const drawn = JSON.stringify(sections);
  assert.doesNotMatch(drawn, /Copy setup continuation|Your AI is connected:|Progress saved|Stop setup|On your devices|App access/);
  assert.ok(!sections.some(section => section.id === 'setup-capabilities' || section.id === 'setup-access'));
  for (const section of sections) for (const step of section.steps ?? []) assert.ok(typeof step.title === 'string' && step.title.length > 0);
});

test('no score, and a failed read never flips a step between views', () => {
  const whole = provenSetup();
  const first = screenOf({ ...whole, now: NOW });
  assert.equal(first.progress, undefined, 'the person is never scored "N of M done"');
  assert.equal(first.ready, true);
  // The same account when one read fails: the step is unknown (never false), the count is not drawn, and it refreshes itself.
  const failed = { ...whole, notificationDevices: null };
  const second = screenOf({ ...failed, now: NOW });
  const step = second.requirements.find(row => row.id === 'notifications');
  assert.equal(step.done, null);
  assert.equal(second.progress, undefined);
  assert.ok(second.refresh_at > Date.now());
  assert.doesNotMatch(JSON.stringify(second.sections), /error|could not|failed/i);
  // The read returns: the same account is ready again, so the guide and the hold agree.
  assert.equal(screenOf({ ...whole, now: NOW }).ready, first.ready);
  // Two renders of the same facts are the same description.
  assert.deepEqual(screenOf({ ...failed, now: NOW }).sections, second.sections);
});

test('the one plain-words pass drops any sentence that names an internal, even one the data forgot', () => {
  const facts = { computers: [{ name: COMPUTER }], owned: { profile: { handle: HANDLE } } };
  const calm = policy.words.plain.still;
  for (const raw of ['SQLITE_LOCKED: database table is locked.', 'claude-code and codex-mcp-client are waiting.', 'Trillion drive keeper stopped.',
    `${COMPUTER} reported in.`, `Signed in as ${HANDLE}.`, 'Ask the release owner.', 'Apple did not confirm TestFlight access.']) {
    assert.equal(plainWords(raw, facts, { plain: policy.words.plain, calm }), calm, raw);
  }
  assert.equal(plainWords('Work is waiting. SQLITE_LOCKED. Your AI retries.', facts, { plain: policy.words.plain, calm }), 'Work is waiting. Your AI retries.');
});

test('no check words in the setup policy print a raw error, id or name field', () => {
  const words = policy.requirements.flatMap(row => row.checks.flatMap(check => [check.found, check.missing, check.found_empty].filter(Boolean)));
  for (const text of words) assert.doesNotMatch(text, /\{(?:error|id|name|ref|reason)\b/, text);
});

test('free-plan check labels say the person\'s result, not an internal', () => {
  const labels = policy.requirements.flatMap(row => row.checks.map(check => check.label));
  assert.ok(labels.includes('Work waiting to run') && labels.includes('Your computer'));
  assert.ok(!labels.includes('Held back') && !labels.includes('Computers reporting in'));
});
