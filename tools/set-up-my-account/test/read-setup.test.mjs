// tool:read-setup, the one read of the Get started screen (tool:get-started). Ported from trillion
// test/catalogue-screen-get-started.test.mjs (tag old-trillion-before-worker-retire) 'read-setup asks the setup owner
// for the asking device's facts and returns what the layout draws', and from test/account-screens.test.mjs's Get started
// tests, over made-up facts:
//   - old readSetup asked GET /setup/facts?user_agent=&origin= of the account's setup owner; here the same question is
//     setup_facts, handed in by the caller with the account's own settings (stored.workspace), and the steps are drawn
//     by tool:see-what-is-left-to-set-up's own function in the same run, with no door;
//   - the drawn screen is compared with a golden (fixtures/get-started-descriptions.json) recorded from the moved
//     setupStepsWithRules and getStartedFacts (byte copies of trillion's, see ../ports/) over the same made-up facts.
//     The tag's own src/setup-steps.mjs does not load at the tag (it imports computer/computer-sources.json and
//     tools/run-experiments/packages/choose-per-observer/read-data/score-candidates.ts, which the tag no longer has), so the golden is the moved
//     code's answer, and the old assertions below are checked against it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readSetup, setupRequest } from '../do-work/read-setup.mjs';
import { seeWhatIsLeftToSetUp } from '../do-work/see-what-is-left-to-set-up.mjs';
import { pendingSetup, provenSetup } from './setup-fixtures.mjs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';

const ROWS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const ROW = rowOf(ROWS, 'tool:read-setup');
const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/get-started-descriptions.json', import.meta.url), 'utf8')).cases;
const ORIGIN = 'https://app.example';
const NOW = '2026-10-08T12:00:00.000Z';
const OWN_RULES = { rules: [] };
// The account's own settings as the caller read them from the person's own store: its show rules, and no setup context.
const OWN = { workspace: { 'show-rules': OWN_RULES, 'setup-context': null } };
// What the caller hands in as setup_facts for this made-up account: its mechanics, and the operator's shared rules and context
// beside them (null context: the operator keeps none for this account).
const answered = facts => ({ facts, shared_rules: { rules: [] }, context: null });
// One read as the caller asks it: the setup facts and the account's own settings handed in.
const asked = (facts, more = {}) => ({ account_id: 'acct-a', origin: ORIGIN, now: NOW, setup_facts: facts, stored: OWN, ...more });

test('read-setup reads the setup facts and settings it is given and answers what the layout draws', async () => {
  const screen = await readSetup(asked(answered(pendingSetup()), { user_agent: 'Mozilla/5.0 (iPhone)', origin: 'https://app.example/work' }));
  assert.equal(screen.title, 'Connect your AI to start');
  await assert.rejects(readSetup({ account_id: 'acct-a', origin: ORIGIN, setup_facts: [] }), /setup_facts is one object/);
  await assert.rejects(readSetup(asked({}, { stored: { workspace: [] } })), /stored is one object/);
  // Asked with no web address, nothing is drawn: the address the page was reached at is input.
  await assert.rejects(readSetup({ account_id: 'acct-a', stored: OWN }), /origin/);
  await assert.rejects(readSetup({}), /account_id/);
});

test('the drawn Get started screen is the golden, for a pending and a proven setup', async () => {
  for (const { name, facts, description } of GOLDEN) {
    const made = { pending: pendingSetup, proven: () => ({ ...provenSetup(), computers: [] }) }[facts]();
    const screen = await readSetup(asked(answered(made), { user_agent: 'Mozilla/5.0 (Macintosh)' }));
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
  const fresh = await readSetup(asked(answered(pendingSetup())));
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
  const all = await readSetup(asked(answered({ ...provenSetup(), computers: [] })));
  assert.equal(all.progress, undefined, 'no "N of M done" score');
  assert.equal(all.title, 'You are all set');
  assert.ok(!all.sections.some(section => section.tabs));
});

// Old readSetupPolicy: each source has its own known bit. The account's own show rules the caller could not read (left
// out of stored.workspace) are unknown (a problem that does not block: personal rules only change how steps read);
// operator rules and context the setup facts do not carry are unknown too, and those keep even a proven setup closed.
test('a source that could not be read is unknown, never empty, so the screen does not open on a guess', async () => {
  const proven = { ...provenSetup(), computers: [] };
  const ownUnread = await readSetup(asked(answered(proven), { stored: { workspace: { 'setup-context': null } } }));
  assert.equal(ownUnread.policy.sources.personal_known, false);
  assert.deepEqual(ownUnread.policy.problems, [{ source: 'personal', reason: 'source-unreadable', blocking: false }]);
  const nothingHanded = await setupRequest(asked(answered(proven), { stored: undefined }));
  assert.equal(Object.hasOwn(nothingHanded, 'rules'), false, 'settings left out are unknown, never an empty rule set');
  assert.equal(Object.hasOwn(nothingHanded, 'personal_context'), false);
  const handed = await setupRequest(asked(answered(proven)));
  assert.deepEqual([handed.rules, handed.personal_context], [OWN_RULES, null], 'a setting handed in as null is read and not there');
  const operatorUnsaid = await readSetup(asked({ facts: proven }));
  assert.equal(operatorUnsaid.ready, false);
  assert.ok(operatorUnsaid.policy.problems.some(problem => problem.source === 'operator' && problem.reason === 'source-unreadable'));
  const all = await readSetup(asked(answered(proven)));
  assert.equal(all.ready, true);
});

test('the row runs its function with its two settings handed in, and reaches no door', async () => {
  assert.equal(ROW.invoke.records, undefined, 'the row opens no records door');
  assert.equal(ROW.stored, undefined, 'the row declares no stored rights');
  assert.deepEqual(ROW.invoke.argv.slice(1), ['/opt/workflows/do-work/run-a-function.mjs', '/opt/set-up-my-account/do-work/read-setup.mjs', 'readSetup']);
  const run = await answerOf(ROW, asked(answered(pendingSetup()), { user_agent: 'Mozilla/5.0 (Macintosh)' }));
  assert.equal(run.status, 0, run.error);
  const { refresh_at: at, ...drawn } = run.result;
  const { refresh_at: goldenAt, ...golden } = GOLDEN.find(item => item.facts === 'pending').description;
  assert.equal(typeof at, typeof goldenAt);
  assert.deepEqual(drawn, golden);
  // The page gets the drawn screen, never an answer around it (on 2026-11-14 a nested run's whole answer left Get started blank).
  for (const around of ['exit_code', 'replayed', 'tool']) assert.equal(Object.hasOwn(run.result, around), false, around);
  const refused = await answerOf(ROW, { account_id: 'acct-a', stored: OWN });
  assert.notEqual(refused.status, 0);
  assert.match(refused.error, /origin/);
});

// setup_facts carries the names the account's sign-ins were made under (`signed_in.names`) and no `system`;
// old /setup/facts drew `devices` from those names (devicesFor({ signedInAs, system, observer, distribution, now }),
// src/native-setup.mjs:243) and the system from the asking browser. Read here the same way.
test('the apps the account has come from the names its sign-ins were made under, and the system from the asking browser', async () => {
  const signedIn = { facts: {}, signed_in: { names: ['Trillion for Mac', 'Claude'], complete: true }, shared_rules: null, context: null, origin: ORIGIN };
  const input = await setupRequest(asked(signedIn, { user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_1)' }));
  assert.equal(input.system, 'macos');
  const installed = Object.fromEntries(input.facts.devices.map(device => [device.id, device.installed]));
  assert.equal(installed.desktop, true, 'signed in as Trillion for Mac');
  assert.equal(installed.iphone, false);
  // No names read: devices stay unknown, never "none installed".
  const unknown = await setupRequest(asked({ facts: {}, shared_rules: null, context: null }));
  assert.equal(unknown.facts.devices, undefined);
});

// setup_facts that carry no setup runtime: Get started reads the setup run the caller hands in (setup_run: the
// status tool:run-workflow-definition answered and the answers given so far, which the caller keeps in the person's own
// database), through the setup runtime moved here from old trillion (from-an-older-version/src/setup-runtime.mjs). No
// setup_run is the true "not started", never "the runtime source is unreadable"; a reader with no owner here answers
// unavailable; nothing is read from or written to any store.
const NO_FACTS = { facts: {}, shared_rules: null, context: null };
const readWith = async setup_run => {
  const request = await setupRequest(asked(NO_FACTS, setup_run ? { setup_run } : {}));
  return { request, workflow: request.facts.runtime.workflow, runtime: request.facts.runtime };
};

test('a new account with no setup run reads its workflow as not started, not as an unreadable runtime', async () => {
  const { request, runtime } = await readWith();
  assert.equal(runtime.schema, 'trillion.setup-runtime/v1');
  assert.equal(runtime.workflow.exists, false);
  assert.equal(runtime.workflow.state, 'not_started');
  assert.equal(runtime.workflow.verified, false);
  assert.match(runtime.workflow.run_id, /^record:calendar-task:workflow:[^:]+:account-setup:v1$/);
  for (const id of ['defaults', 'timed_work', 'event_intake', 'agents']) {
    assert.equal(runtime.components.find(row => row.id === id).state, 'unknown', `${id} has no reader here, so it is unknown`);
  }
  const screen = await seeWhatIsLeftToSetUp(request);
  assert.doesNotMatch(JSON.stringify(screen), /runtime-source-unreadable/);
});

test('a started setup run reads as working, and its answers are the steps it admitted', async () => {
  const inventory = { requirements: [] };
  const { workflow } = await readWith({ status: 'paused', answers: { discover: inventory } });
  assert.equal(workflow.exists, true);
  assert.equal(workflow.state, 'working');
  assert.equal(workflow.verified, false, 'no verify-outcome answer is given, so nothing is verified');
  assert.deepEqual(workflow.inventory, inventory, 'the discovery answer is the inventory');
});

test('a verify-outcome answer given without the earlier answers it rests on does not read as verified', async () => {
  const { workflow } = await readWith({ status: 'paused', answers: { 'verify-outcome': { verified: [] } } });
  assert.equal(workflow.verified, false);
});

test('a setup run reads as finished only once the engine says it completed', async () => {
  const answers = { discover: { requirements: [] }, assign: {}, configure: {} };
  assert.equal((await readWith({ status: 'paused', answers })).workflow.state, 'working', 'three of four steps answered is still working');
  assert.equal((await readWith({ status: 'completed', answers: { ...answers, 'verify-outcome': {} } })).workflow.state, 'finished');
  assert.equal((await readWith({ status: 'failed', answers })).workflow.state, 'failed');
});

test('a runtime the setup facts already carry is used as it is', async () => {
  const carried = { facts: { runtime: { schema: 'trillion.setup-runtime/v1', components: [], workflow: { exists: true, state: 'finished' } } }, shared_rules: null, context: null };
  assert.equal((await setupRequest(asked(carried))).facts.runtime.workflow.state, 'finished');
});

test('run as its row, with no runtime in the setup facts, the setup run is read from its input', async () => {
  const run = await answerOf(ROW, asked(NO_FACTS));
  assert.equal(run.status, 0, run.error);
  assert.doesNotMatch(JSON.stringify(run.result), /runtime-source-unreadable/);
});
