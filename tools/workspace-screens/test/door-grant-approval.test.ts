// tools/workspace-screens/test/door-grant-approval.test.ts
// The grants screen reads the person's approval setting from the approvals owner place (the owner-places record's role),
// never from the workspace's own records database: a covered request is kept without a press, and anything the setting
// does not cover, or a place that cannot be read, waits for the person's Allow.
import assert from 'node:assert/strict';
import test from 'node:test';
import { autoDecisionFor } from '../web/src/workspace/door-grant-approval.ts';

const placesRow = (roles: Record<string, unknown>) => ({ rows: [{ value: JSON.stringify({ roles }) }] });
const approvals = {
  credential_name: 'pursuit-connection',
  table: 'approval_setting',
  decision_table: 'approval_decision',
  approver: 'owner-person',
};

/** A stand-in door: it records each tool run's input, and answers from the given rows in turn. */
function standIn(answers: unknown[]) {
  const runs: { tool: string; input: Record<string, unknown> }[] = [];
  const run = async (tool: string, input: Record<string, unknown>) => {
    runs.push({ tool, input });
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return { tool, exit_code: 0, result: answer };
  };
  return { runs, run: run as Parameters<typeof autoDecisionFor>[1] };
}

test('the approval check is read from the approvals owner place, not the records database, and a covered ask is an auto decision', async () => {
  const door = standIn([
    placesRow({ approvals }),
    { rows: [{ person: 'owner-person', scope: 'door-grant', mode: 'auto', set_by: 'owner-person', decision_id: 'decision-1' }] },
  ]);
  const auto = await autoDecisionFor('Sam', door.run);

  assert.equal(door.runs.length, 2);
  assert.equal(door.runs[1].input.credential_name, 'pursuit-connection');
  assert.match(String(door.runs[1].input.sql), /FROM approval_setting/);
  assert.match(String(door.runs[1].input.sql), /INTO approval_decision/);
  assert.match(String(door.runs[1].input.sql), /WHERE person = \$1 AND scope IN \(\$2, '\*'\)/);
  assert.deepEqual(door.runs[1].input.params, ['owner-person', 'door-grant', 'grant:Sam']);
  assert.equal(door.runs[1].input.statement_timeout_ms, 5000);
  assert.deepEqual(auto, { decision_id: 'decision-1', setting_id: 'approval_setting:owner-person:door-grant', mode: 'auto' });
});

test('a setting that does not cover the ask (mode ask, or no row) waits for the person', async () => {
  const asked = standIn([placesRow({ approvals }), { rows: [{ person: 'owner-person', scope: 'door-grant', mode: 'ask', set_by: 'owner-person', decision_id: null }] }]);
  assert.equal(await autoDecisionFor('Sam', asked.run), null);

  const none = standIn([placesRow({ approvals }), { rows: [] }]);
  assert.equal(await autoDecisionFor('Sam', none.run), null);
});

test('no approvals role, no approver, or a table name that is not plain asks the person and reads no approval', async () => {
  const noRole = standIn([placesRow({})]);
  assert.equal(await autoDecisionFor('Sam', noRole.run), null);
  assert.equal(noRole.runs.length, 1);

  const noApprover = standIn([placesRow({ approvals: { ...approvals, approver: '' } })]);
  assert.equal(await autoDecisionFor('Sam', noApprover.run), null);
  assert.equal(noApprover.runs.length, 1);

  const badName = standIn([placesRow({ approvals: { ...approvals, table: 'approval_setting; drop table x' } })]);
  assert.equal(await autoDecisionFor('Sam', badName.run), null);
  assert.equal(badName.runs.length, 1);
});

test('a place or check that cannot be read asks the person', async () => {
  const unreadable = standIn([new Error('connection refused')]);
  assert.equal(await autoDecisionFor('Sam', unreadable.run), null);

  const unreadableCheck = standIn([placesRow({ approvals }), new Error('relation "approval_setting" does not exist')]);
  assert.equal(await autoDecisionFor('Sam', unreadableCheck.run), null);
});
