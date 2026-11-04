// src/task-proposals.mjs (DATA: src/task-proposals.json): tasks an AI found are proposals the person approves, rejects,
// restores or takes back; only an approval makes a real Calendar task, once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { makeLists } from '../../keep-lists-of-rows/lists.mjs';
import { readCalendarTasks } from '../../plan-tasks-and-todo-lists/calendar-tasks.mjs';
import { TaskProposalError, changeTaskProposals, proposalId } from '../src/task-proposals.mjs';

const owner = () => { const store = localStore(':memory:'); return { store, lists: makeLists({ eeaf: store.eeaf }) }; };
const tasks = lists => readCalendarTasks(lists).tasks;

test('proposing writes only proposals; the same finding is one proposal however often it is found', () => {
  const { store, lists } = owner();
  try {
    const first = changeTaskProposals(lists, { action: 'propose', source_id: 'meeting:standup-10-19', proposed_by: 'notes-ai', items: [
      { title: 'Send Ana the pricing deck', due: '2026-10-23', evidence: '"I will send the deck by Friday"' },
      { title: 'Book the offsite', duration_minutes: 60 },
    ] });
    assert.deepEqual(first.proposals.map(item => item.state), ['proposed', 'proposed']);
    assert.equal(tasks(lists).length, 0, 'no task exists until the person approves');
    const again = changeTaskProposals(lists, { action: 'propose', source_id: 'meeting:standup-10-19', items: [{ title: '  send ana the PRICING deck ' }] });
    assert.equal(again.proposals[0].kept, true);
    assert.equal(again.proposals[0].proposal_id, first.proposals[0].proposal_id);
    assert.equal(changeTaskProposals(lists, { action: 'read' }).proposals.length, 2);
    assert.equal(proposalId('meeting:standup-10-19', 'Book the offsite').length, 'proposal-'.length + 32);
    assert.notEqual(proposalId('meeting:other', 'Book the offsite'), proposalId('meeting:standup-10-19', 'Book the offsite'));
  } finally { store.close?.(); }
});

test('approving makes exactly one Calendar task with the finding\'s details; undoing the approval deletes it', () => {
  const { store, lists } = owner();
  try {
    const { proposals: [one] } = changeTaskProposals(lists, { action: 'propose', source_id: 'meeting:m1', items: [{ title: 'Send Ana the deck', due: '2026-10-23', duration_minutes: 45 }] });
    const approved = changeTaskProposals(lists, { action: 'approve', proposal_id: one.proposal_id });
    assert.equal(approved.state, 'approved');
    const [task] = tasks(lists);
    assert.equal(task.id, approved.task_id);
    assert.deepEqual([task.title, task.due, task.duration_minutes, task.source_id], ['Send Ana the deck', '2026-10-23', 45, 'meeting:m1']);
    const twice = changeTaskProposals(lists, { action: 'approve', proposal_id: one.proposal_id });
    assert.equal(twice.kept, true);
    assert.equal(tasks(lists).length, 1, 'approving twice makes one task');
    assert.throws(() => changeTaskProposals(lists, { action: 'reject', proposal_id: one.proposal_id }), /already a task\. Undo the approval first/);
    const undone = changeTaskProposals(lists, { action: 'undo_approval', proposal_id: one.proposal_id });
    assert.equal(undone.state, 'proposed');
    assert.equal(tasks(lists).length, 0, 'the task it made is gone');
    assert.equal(changeTaskProposals(lists, { action: 'approve', proposal_id: one.proposal_id }).state, 'approved', 'it can be approved again');
    assert.equal(tasks(lists).length, 1);
    assert.throws(() => changeTaskProposals(lists, { action: 'undo_approval', proposal_id: 'proposal-nope' }), /There is no proposal proposal-nope/);
  } finally { store.close?.(); }
});

test('a rejected finding stays rejected until restored, and a proposal can be edited only while it waits', () => {
  const { store, lists } = owner();
  try {
    const { proposals: [one] } = changeTaskProposals(lists, { action: 'propose', source_id: 's', items: [{ title: 'Call the landlord' }] });
    const edited = changeTaskProposals(lists, { action: 'edit', proposal_id: one.proposal_id, title: 'Call the landlord about the lease', due: '2026-11-01' });
    assert.equal(edited.proposal.title, 'Call the landlord about the lease');
    assert.equal(changeTaskProposals(lists, { action: 'reject', proposal_id: one.proposal_id }).state, 'rejected');
    const found = changeTaskProposals(lists, { action: 'propose', source_id: 's', items: [{ title: 'Call the landlord' }] });
    assert.equal(found.proposals[0].proposal_id, one.proposal_id, 'edits do not change the finding\'s identity');
    assert.throws(() => changeTaskProposals(lists, { action: 'edit', proposal_id: one.proposal_id, title: 'x' }), /rejected; only a proposal waiting for review can be changed/);
    assert.throws(() => changeTaskProposals(lists, { action: 'approve', proposal_id: 'x/y' }), TaskProposalError);
    assert.equal(changeTaskProposals(lists, { action: 'restore', proposal_id: one.proposal_id }).state, 'proposed');
    assert.throws(() => changeTaskProposals(lists, { action: 'restore', proposal_id: one.proposal_id }), /is not rejected/);
    assert.equal(changeTaskProposals(lists, { action: 'read', state: 'rejected' }).proposals.length, 0);
    assert.throws(() => changeTaskProposals(lists, { action: 'launch' }), /Choose propose, approve, reject, restore, undo_approval, edit or read/);
    assert.throws(() => changeTaskProposals(lists, { action: 'propose', items: [] }), /up to 50 tasks/);
  } finally { store.close?.(); }
});

test('the route and tools drive the same proposals', async () => {
  const { handleTaskProposalRequest, isTaskProposalPath, taskProposalTools, taskProposalAnnotations } = await import('../src/task-proposals.mjs');
  const { store, lists } = owner();
  try {
    const call = async (path, body) => {
      const response = await handleTaskProposalRequest(lists, new Request(`https://person${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }));
      return { status: response.status, body: await response.json() };
    };
    const tools = taskProposalTools(async (path, body) => (await call(path, body)).body);
    assert.deepEqual(tools.map(tool => tool.name).filter(name => !taskProposalAnnotations[name]), []);
    const proposed = await tools[0].run({ source_id: 'mail:1', items: [{ title: 'Pay the invoice' }] });
    const id = proposed.proposals[0].proposal_id;
    assert.equal((await tools[2].run({ state: 'proposed' })).proposals.length, 1);
    assert.equal((await tools[1].run({ action: 'approve', proposal_id: id })).state, 'approved');
    assert.equal((await tools[2].run({ state: 'proposed' })).proposals.length, 0);
    assert.equal((await call('/calendar/task-proposals', { action: 'reject', proposal_id: id })).status, 400);
    assert.equal(isTaskProposalPath('/calendar/task-proposals') && !isTaskProposalPath('/calendar/tasks'), true);
  } finally { store.close?.(); }
});
