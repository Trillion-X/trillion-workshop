// The row's entry: refusals, unknown sources keep the screen not ready, a proven setup with every source read is
// ready, and the row's sample run through the container runner. Every account and address here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seeWhatIsLeftToSetUp } from '../do-work/see-what-is-left-to-set-up.mjs';
import { pendingSetup, provenSetup } from './setup-fixtures.mjs';
import { runRow } from '../../../test-helpers/run-a-row.mjs';

const ROWS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const NOW = '2026-10-08T12:00:00.000Z';
const ORIGIN = 'https://app.example.test';
const everySource = { shared_rules: { rules: [] }, rules: { rules: [] }, context: null, personal_context: null };

test('a request with no account, a facts list or a bad time is refused with what to send', async () => {
  await assert.rejects(seeWhatIsLeftToSetUp(null), /one JSON object/);
  await assert.rejects(seeWhatIsLeftToSetUp({ facts: {} }), /account_id/);
  await assert.rejects(seeWhatIsLeftToSetUp({ account_id: 'acct-a', facts: [] }), /facts is an object/);
  await assert.rejects(seeWhatIsLeftToSetUp({ account_id: 'acct-a', now: 'soon' }), /ISO time/);
});

test('rules and setup context the request leaves out are unknown, so even a proven setup is not ready', async () => {
  const screen = await seeWhatIsLeftToSetUp({ account_id: 'acct-a', facts: provenSetup(), origin: ORIGIN, now: NOW });
  assert.equal(screen.ready, false);
  assert.equal(screen.policy.requirements_resolved, false);
  assert.ok(screen.policy.problems.some(problem => problem.source === 'operator' && problem.reason === 'source-unreadable'));
});

test('a proven setup with every source read is ready, and a pending one lists its steps without opening', async () => {
  const proven = await seeWhatIsLeftToSetUp({ account_id: 'acct-a', facts: { ...provenSetup(), computers: [] }, ...everySource, origin: ORIGIN, now: NOW });
  assert.equal(proven.policy.requirements_resolved, true);
  assert.equal(proven.ready, true);
  const pending = await seeWhatIsLeftToSetUp({ account_id: 'acct-a', facts: { ...pendingSetup(), computers: [] }, ...everySource, origin: ORIGIN, now: NOW });
  assert.equal(pending.ready, false);
  assert.ok(pending.sections.some(section => section.id === 'setup-with-ai'), 'before an AI is connected the connect choices are drawn');
  assert.ok(JSON.stringify(pending).includes(`${ORIGIN}/mcp`), 'the AI guides name the address the request gave');
});

test('the row runs its sample the way the engine runs it', async () => {
  for (const { payload } of ROWS.records.filter(record => record.payload.id === 'tool:see-what-is-left-to-set-up')) {
    const run = await runRow(payload, payload.verify[0].input);
    if (run.cannot) continue;
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.last.result.sections[1].id, 'setup-with-ai');
  }
});
