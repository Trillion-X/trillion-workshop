// src/task-proposals.mjs
//
// PURPOSE
//   Tasks found by an AI or a rule (action items in a meeting, requests in an email) are proposals the person reviews, never
//   tasks created on their behalf. A proposal is a row of the generic Lists owner; approving one makes the real Calendar task
//   through the Calendar tasks owner (so every rule of a task applies) and records which task it made; rejecting keeps the row
//   so the same finding is not proposed again; restoring un-rejects; undoing an approval deletes the task it made.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing becomes a task without an explicit approve: propose writes only proposal rows.
//   2. A finding is one proposal: its id is the BLAKE3 of its source and its normalised title, so proposing it again (a
//      retry, a second pass over the same meeting) changes nothing, and a rejected finding stays rejected until restored.
//   3. Approving twice makes one task (the Calendar request key is the proposal id); undoing an approval deletes exactly that task.
//   4. Tasks are written only through changeCalendarTask and proposals only through the Lists owner; nothing here keeps state.
//
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import data from '../../shared-code/src/task-proposals.json' with { type: 'json' };
import { CalendarTasksError, changeCalendarTask } from './calendar-tasks.mjs';

export class TaskProposalError extends CalendarTasksError {}

const LIST = data.list;
const ACTOR = { by: 'task-proposals' };
const say = (key, values = {}) => data.words[key].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const plain = text => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const shaped = row => ({ proposal_id: row.id, ...row.values });

/** The id of a finding: one per source and normalised title. */
export const proposalId = (sourceId, title) => `proposal-${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify([plain(sourceId), plain(title)])))).slice(0, 32)}`;

const ensure = lists => lists.ensure(LIST, { actor: ACTOR });
const rowOf = (lists, id) => {
  if (typeof id !== 'string' || !id.trim() || id.includes('/')) throw new TaskProposalError(say('bad_id'));
  const row = lists.row(LIST.id, id.trim());
  if (!row) throw new TaskProposalError(say('no_proposal', { id }));
  return row;
};
const put = (lists, id, values) => lists.putRows(LIST.id, { rows: [{ id, values }] }, { actor: ACTOR }).kept[0];

function propose(lists, input) {
  const items = input.items;
  if (!Array.isArray(items) || !items.length || items.length > data.limits.proposals_per_call) throw new TaskProposalError(say('bad_items', { most: data.limits.proposals_per_call }));
  const sourceId = typeof input.source_id === 'string' ? input.source_id.trim().slice(0, data.limits.source_chars) : '';
  const proposedBy = typeof input.proposed_by === 'string' ? input.proposed_by.trim().slice(0, data.limits.proposed_by_chars) : '';
  const results = [];
  for (const item of items) {
    const title = object(item) && typeof item.title === 'string' ? item.title.trim() : '';
    if (!title || title.length > data.limits.title_chars) throw new TaskProposalError(say('bad_title', { most: data.limits.title_chars }));
    const id = proposalId(sourceId, title);
    const existing = lists.row(LIST.id, id);
    if (existing) {
      const state = existing.values.state;
      results.push({ proposal_id: id, state, kept: true, said: say(state === 'rejected' ? 'already_rejected' : 'again', { title, state }) });
      continue;
    }
    const minutes = Number.isSafeInteger(item.duration_minutes) ? item.duration_minutes : data.default_duration_minutes;
    const saved = put(lists, id, {
      title, state: 'proposed', duration_minutes: minutes, source_id: sourceId || null, proposed_by: proposedBy || null,
      due: typeof item.due === 'string' && item.due ? item.due : null,
      evidence: typeof item.evidence === 'string' ? item.evidence.slice(0, data.limits.evidence_chars) : null,
    });
    results.push({ proposal_id: id, state: 'proposed', kept: false, proposal: shaped(saved), said: say('proposed', { title }) });
  }
  return { proposals: results };
}

function approve(lists, input) {
  const row = rowOf(lists, input.proposal_id);
  const { title } = row.values;
  if (row.values.state === 'approved' && row.values.task_id) return { proposal_id: row.id, state: 'approved', task_id: row.values.task_id, kept: true, said: say('approved_before', { title }) };
  const made = changeCalendarTask(lists, {
    action: 'create', request_key: row.id, title, duration_minutes: row.values.duration_minutes ?? data.default_duration_minutes,
    ...(row.values.due ? { due: row.values.due } : {}), ...(row.values.source_id ? { source_id: row.values.source_id } : {}),
    ...(typeof input.collection_id === 'string' ? { collection_id: input.collection_id } : {}),
  });
  const saved = put(lists, row.id, { state: 'approved', task_id: made.task.id });
  return { proposal_id: row.id, state: 'approved', task_id: made.task.id, proposal: shaped(saved), said: say('approved', { title }) };
}

function reject(lists, input) {
  const row = rowOf(lists, input.proposal_id);
  const { title } = row.values;
  if (row.values.state === 'approved') throw new TaskProposalError(say('approved_cannot_reject', { title }));
  const saved = put(lists, row.id, { state: 'rejected' });
  return { proposal_id: row.id, state: 'rejected', proposal: shaped(saved), said: say('rejected', { title }) };
}

function restore(lists, input) {
  const row = rowOf(lists, input.proposal_id);
  const { title } = row.values;
  if (row.values.state !== 'rejected') throw new TaskProposalError(say('not_rejected', { title }));
  const saved = put(lists, row.id, { state: 'proposed' });
  return { proposal_id: row.id, state: 'proposed', proposal: shaped(saved), said: say('restored', { title }) };
}

function undoApproval(lists, input) {
  const row = rowOf(lists, input.proposal_id);
  const { title } = row.values;
  if (row.values.state !== 'approved' || !row.values.task_id) throw new TaskProposalError(say('not_approved', { title }));
  changeCalendarTask(lists, { action: 'delete', task_id: row.values.task_id });
  const saved = put(lists, row.id, { state: 'proposed', task_id: null });
  return { proposal_id: row.id, state: 'proposed', proposal: shaped(saved), said: say('undone', { title }) };
}

function edit(lists, input) {
  const row = rowOf(lists, input.proposal_id);
  if (row.values.state !== 'proposed') throw new TaskProposalError(say('not_editable', { title: row.values.title, state: row.values.state }));
  const values = {};
  if (Object.hasOwn(input, 'title')) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title || title.length > data.limits.title_chars) throw new TaskProposalError(say('bad_title', { most: data.limits.title_chars }));
    values.title = title;
  }
  if (Object.hasOwn(input, 'due')) values.due = input.due || null;
  if (Object.hasOwn(input, 'duration_minutes')) values.duration_minutes = input.duration_minutes;
  const saved = put(lists, row.id, values);
  return { proposal_id: row.id, state: 'proposed', proposal: shaped(saved), said: say('edited', { title: saved.values.title }) };
}

function read(lists, input) {
  if (typeof input.proposal_id === 'string' && input.proposal_id) return { proposal: shaped(rowOf(lists, input.proposal_id)) };
  const wanted = typeof input.state === 'string' ? input.state : null;
  const page = lists.read(LIST.id, { limit: 50, ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}) });
  return { proposals: page.rows.map(shaped).filter(item => !wanted || item.state === wanted), page: { complete: page.page.complete, next_cursor: page.page.next_cursor } };
}

const ACTIONS = { propose, approve, reject, restore, undo_approval: undoApproval, edit, read };

/** One call for every proposal action: { action, ... }. Answers the action's result, or throws TaskProposalError in plain words. */
export function changeTaskProposals(lists, input) {
  if (!object(input) || !Object.hasOwn(ACTIONS, input.action)) throw new TaskProposalError(say('bad_action'));
  ensure(lists);
  return ACTIONS[input.action](lists, input);
}

/** The route: POST /calendar/task-proposals { action, ... } changes; GET reads (?proposal_id=, ?state=, ?cursor=). */
export async function handleTaskProposalRequest(lists, request) {
  try {
    const url = new URL(request.url);
    if (request.method === 'GET') return Response.json(changeTaskProposals(lists, { action: 'read', ...Object.fromEntries(url.searchParams) }));
    if (request.method === 'POST') return Response.json(changeTaskProposals(lists, await request.json().catch(() => null)));
    return Response.json({ error: 'Method not allowed.' }, { status: 405 });
  } catch (error) {
    return Response.json({ error: String(error?.message ?? error) }, { status: error instanceof CalendarTasksError ? 400 : 500 });
  }
}

export const isTaskProposalPath = path => path === '/calendar/task-proposals';

/** The MCP tools of task proposals, in the shape other tool lists use ({ name, description, inputSchema, run }). */
export const taskProposalTools = call => [
  { name: 'propose_tasks', description: 'Keeps tasks you found (action items in a meeting, requests in a message) as proposals for the person to review. It never makes a task. items is a list of up to 50 { title, due (YYYY-MM-DD, optional), duration_minutes (optional), evidence (the words they came from, optional) }; source_id names where they came from (a meeting, a message), so finding the same thing again changes nothing and a rejected one is not proposed again. The person approves or rejects each one (review_proposed_task).', inputSchema: { type: 'object', required: ['items'], properties: { source_id: { type: 'string' }, proposed_by: { type: 'string' }, items: { type: 'array', maxItems: data.limits.proposals_per_call, items: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, due: { type: 'string' }, duration_minutes: { type: 'integer' }, evidence: { type: 'string' } } } } } }, run: input => call('/calendar/task-proposals', { ...input, action: 'propose' }) },
  { name: 'review_proposed_task', description: 'Acts on one proposed task by proposal_id: approve makes the Calendar task (once), reject keeps it from being proposed again, restore un-rejects it, undo_approval deletes the task an approval made and returns the proposal to review, edit changes its title, due date or minutes while it waits.', inputSchema: { type: 'object', required: ['action', 'proposal_id'], properties: { action: { type: 'string', enum: ['approve', 'reject', 'restore', 'undo_approval', 'edit'] }, proposal_id: { type: 'string' }, title: { type: 'string' }, due: { type: 'string' }, duration_minutes: { type: 'integer' }, collection_id: { type: 'string', description: 'With approve: the task list the new task goes in' } } }, run: input => call('/calendar/task-proposals', input) },
  { name: 'list_proposed_tasks', description: 'The tasks found for this person and waiting for review (state proposed), approved or rejected, with where each came from. Give state to see one kind and proposal_id to read one. It changes nothing.', inputSchema: { type: 'object', properties: { state: { type: 'string', enum: ['proposed', 'approved', 'rejected'] }, proposal_id: { type: 'string' }, cursor: { type: 'string' } } }, run: (input = {}) => call(`/calendar/task-proposals?${new URLSearchParams(Object.entries(input).filter(([, value]) => typeof value === 'string')).toString()}`) },
];

export const taskProposalAnnotations = {
  propose_tasks: { title: 'Propose tasks for review', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  review_proposed_task: { title: 'Approve, reject or take back a proposed task', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  list_proposed_tasks: { title: 'List proposed tasks', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
