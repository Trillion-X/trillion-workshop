// tool:read-setup, the one read of the Get started screen (tool:get-started). Ported from trillion
// test/catalogue-screen-get-started.test.mjs (tag old-trillion-before-worker-retire) 'read-setup asks the setup owner
// for the asking device's facts and returns what the layout draws', and from test/account-screens.test.mjs's Get started
// tests, over made-up facts:
//   - old readSetup asked GET /setup/facts?user_agent=&origin= of the account's setup owner; here the same question is
//     the account files door's setup_facts (the brief's contract C), and the steps are drawn by
//     tool:see-what-is-left-to-set-up, run through the door (contract A);
//   - the drawn screen is compared with a golden (fixtures/get-started-descriptions.json) recorded from the moved
//     setupStepsWithRules and getStartedFacts (byte copies of trillion's, see ../ports/) over the same made-up facts.
//     The tag's own src/setup-steps.mjs does not load at the tag (it imports computer/computer-sources.json and
//     parts/choose-per-observer/read-data/score-candidates.ts, which the tag no longer has), so the golden is the moved
//     code's answer, and the old assertions below are checked against it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readSetup } from '../do-work/read-setup.mjs';
import { seeWhatIsLeftToSetUp } from '../do-work/see-what-is-left-to-set-up.mjs';
import { pendingSetup, provenSetup } from './setup-fixtures.mjs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';

const ROWS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const ROW = rowOf(ROWS, 'tool:read-setup');
const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/get-started-descriptions.json', import.meta.url), 'utf8')).cases;
const ORIGIN = 'https://app.example';
const NOW = '2026-10-08T12:00:00.000Z';
const OWN_RULES = { rules: [] };
// What the files door answers for this made-up account: its mechanics, and the operator's shared rules and context
// beside them (null context: the operator keeps none for this account).
const answered = facts => ({ facts, shared_rules: { rules: [] }, context: null });

// A stand-in door: setup_facts answers `facts`, the account's own records are `records` (a label that throws is
// unreadable), and a run of tool:see-what-is-left-to-set-up is that tool's own function.
function door({ facts, records = { 'show-rules': OWN_RULES, 'setup-context': null }, refuse = null }) {
  const asked = [];
  return {
    asked,
    async files(operation, input) {
      asked.push([operation, input]);
      if (refuse) throw Object.assign(new Error('Refused.'), { status: refuse });
      return facts;
    },
    async readWorkspace([label]) {
      asked.push(['workspace:read', label]);
      if (records[label] instanceof Error) throw records[label];
      return { records: Object.hasOwn(records, label) ? { [label]: records[label] } : {} };
    },
    async run(tool, input, { key }) { asked.push(['tools:run', tool, key]); return seeWhatIsLeftToSetUp(input); },
  };
}

test('read-setup asks the setup facts for the asking device and answers what the layout draws', async () => {
  const pending = door({ facts: answered(pendingSetup()) });
  const screen = await readSetup({ account_id: 'acct-a', user_agent: 'Mozilla/5.0 (iPhone)', origin: 'https://app.example/work', now: NOW }, { door: pending });
  assert.deepEqual(pending.asked, [['setup_facts', { user_agent: 'Mozilla/5.0 (iPhone)', origin: ORIGIN }],
    ['workspace:read', 'show-rules'], ['workspace:read', 'setup-context'], ['tools:run', 'tool:see-what-is-left-to-set-up', 'read-setup:acct-a']]);
  assert.equal(screen.title, 'Connect your AI to start');
  await assert.rejects(readSetup({ account_id: 'acct-a' }, { door: door({ refuse: 402 }) }), error => error.status === 402);
  // Asked with no web address, the setup steps name the service's own address (2026-10-20).
  const unaddressed = door({ facts: answered(pendingSetup()) });
  await readSetup({ account_id: 'acct-a' }, { door: unaddressed });
  assert.deepEqual(unaddressed.asked[0], ['setup_facts', { user_agent: '', origin: 'https://app.gettrillion.ai' }]);
  await assert.rejects(readSetup({}, { door: unaddressed }), /account_id/);
});

test('the drawn Get started screen is the golden, for a pending and a proven setup', async () => {
  for (const { name, facts, description } of GOLDEN) {
    const made = { pending: pendingSetup, proven: () => ({ ...provenSetup(), computers: [] }) }[facts]();
    const screen = await readSetup({ account_id: 'acct-a', user_agent: 'Mozilla/5.0 (Macintosh)', origin: ORIGIN, now: NOW }, { door: door({ facts: answered(made) }) });
    // refresh_at is getStartedFacts' own wall clock (Date.now() plus the gate's read_every_seconds), not the request's.
    const { refresh_at: at, ...drawn } = JSON.parse(JSON.stringify(screen));
    const { refresh_at: goldenAt, ...golden } = description;
    assert.equal(typeof at, typeof goldenAt, name);
    assert.deepEqual(drawn, golden, name);
  }
});

// Old test/account-screens.test.mjs 'Get started carries the whole setup to the AI from inside the required screen',
// its assertions over the screen read-setup draws.
test('Get started carries the whole setup to the AI from inside the required screen', async () => {
  const fresh = await readSetup({ account_id: 'acct-a', origin: ORIGIN, now: NOW }, { door: door({ facts: answered(pendingSetup()) }) });
  assert.equal(fresh.progress, undefined, 'a count is only drawn once every step could be read, so it never flips with a failed read');
  assert.equal(fresh.title, 'Connect your AI to start', 'a new account is asked for the one thing that starts everything');
  assert.ok(fresh.sections[0].tabs.length > 0);
  assert.equal(fresh.sections[0].tabs_require_choice, true, 'a fresh setup leaves the AI choice to the person');
  for (const tab of fresh.sections[0].tabs) {
    assert.match(tab.copy.text, /start_setup/);
    assert.match(tab.copy.text, /read_setup/);
    assert.deepEqual(tab.steps, [], 'the required screen delegates setup instead of showing every app manual');
  }
  assert.doesNotMatch(JSON.stringify(fresh.sections), /Copy setup continuation|Progress saved|Stop setup|On your devices/);
  assert.ok((fresh.sections.find(section => section.id === 'setup-steps')?.steps ?? []).every(step => step.done === true));
  const all = await readSetup({ account_id: 'acct-a', origin: ORIGIN, now: NOW }, { door: door({ facts: answered({ ...provenSetup(), computers: [] }) }) });
  assert.equal(all.progress, undefined, 'no "N of M done" score');
  assert.equal(all.title, 'You are all set');
  assert.ok(!all.sections.some(section => section.tabs));
});

// Old readSetupPolicy: each source has its own known bit. The account's own show rules that could not be read are
// unknown (a problem that does not block: personal rules only change how steps read); operator rules and context the
// files door does not carry are unknown too, and those keep even a proven setup closed.
test('a source that could not be read is unknown, never empty, so the screen does not open on a guess', async () => {
  const proven = { ...provenSetup(), computers: [] };
  const ownUnread = await readSetup({ account_id: 'acct-a', origin: ORIGIN, now: NOW },
    { door: door({ facts: answered(proven), records: { 'show-rules': new Error('unavailable'), 'setup-context': null } }) });
  assert.equal(ownUnread.policy.sources.personal_known, false);
  assert.deepEqual(ownUnread.policy.problems, [{ source: 'personal', reason: 'source-unreadable', blocking: false }]);
  const operatorUnsaid = await readSetup({ account_id: 'acct-a', origin: ORIGIN, now: NOW }, { door: door({ facts: { facts: proven } }) });
  assert.equal(operatorUnsaid.ready, false);
  assert.ok(operatorUnsaid.policy.problems.some(problem => problem.source === 'operator' && problem.reason === 'source-unreadable'));
  const all = await readSetup({ account_id: 'acct-a', origin: ORIGIN, now: NOW }, { door: door({ facts: answered(proven) }) });
  assert.equal(all.ready, true);
});

test('the row runs through the door with exactly its rights: setup_facts, its own two records and the one tool it runs', async () => {
  const run = await answerOf(ROW, { account_id: 'acct-a', user_agent: 'Mozilla/5.0 (Macintosh)', origin: ORIGIN, now: NOW }, {
    records: [], doorOptions: { workspaceRecords: { 'show-rules': OWN_RULES, 'setup-context': null } },
    file_answers: { setup_facts: answered(pendingSetup()) },
    tool_runs: { 'tool:see-what-is-left-to-set-up': input => seeWhatIsLeftToSetUp(input) },
  });
  assert.equal(run.status, 0, run.error);
  const { refresh_at: at, ...drawn } = run.result;
  const { refresh_at: goldenAt, ...golden } = GOLDEN.find(item => item.facts === 'pending').description;
  assert.equal(typeof at, typeof goldenAt);
  assert.deepEqual(drawn, golden);
  assert.deepEqual(run.runs.map(item => item.tool), ['tool:see-what-is-left-to-set-up']);
  assert.deepEqual(ROW.invoke.records.runs, ['tool:see-what-is-left-to-set-up']);
});

// The engine's setup_facts answers the names the account's sign-ins were made under (`signed_in.names`) and no `system`;
// old /setup/facts drew `devices` from those names (devicesFor({ signedInAs, system, observer, distribution, now }),
// src/native-setup.mjs:243) and the system from the asking browser. Read here the same way.
test('the apps the account has come from the names its sign-ins were made under, and the system from the asking browser', async () => {
  const sent = [];
  const engine = {
    async files() { return { facts: {}, signed_in: { names: ['Trillion for Mac', 'Claude'], complete: true }, shared_rules: null, context: null, origin: ORIGIN }; },
    async readWorkspace([label]) { return { records: { [label]: null } }; },
    async run(tool, input) { sent.push(input); return seeWhatIsLeftToSetUp(input); },
  };
  await readSetup({ account_id: 'acct-a', user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_1)', origin: ORIGIN, now: NOW }, { door: engine });
  const [input] = sent;
  assert.equal(input.system, 'macos');
  const installed = Object.fromEntries(input.facts.devices.map(device => [device.id, device.installed]));
  assert.equal(installed.desktop, true, 'signed in as Trillion for Mac');
  assert.equal(installed.iphone, false);
  // No names read: devices stay unknown, never "none installed".
  const unknown = [];
  await readSetup({ account_id: 'acct-a', now: NOW }, { door: { ...engine, async files() { return { facts: {}, shared_rules: null, context: null }; }, async run(tool, input) { unknown.push(input); return seeWhatIsLeftToSetUp(input); } } });
  assert.equal(unknown[0].facts.devices, undefined);
});
