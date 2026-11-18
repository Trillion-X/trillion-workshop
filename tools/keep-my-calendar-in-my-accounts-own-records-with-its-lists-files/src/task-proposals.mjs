// src/task-proposals.mjs
//
// PURPOSE
//   Read side of the proposed tasks an AI or a rule found (action items in a meeting, requests in an email), which the person
//   reviews. Keeping them (propose, approve, reject, restore, edit, undo) moved to workflow:keep-my-calendar-tasks-and-proposals
//   (recipes/kit in this folder's kits/), so this file only answers what those proposals are. Nothing here writes.
//
// NON-NEGOTIABLE INVARIANTS
//   1. GET reads only: a proposal by id, or the proposals of one state, in pages. Any other method is refused.
//   2. Reading a list that is not kept yet answers no proposals; it does not make the list.
//
import data from '../../shared-code/src/task-proposals.json' with { type: 'json' };
import { CalendarTasksError } from '../../plan-tasks-and-todo-lists/calendar-tasks.mjs';

export class TaskProposalError extends CalendarTasksError {}

const LIST = data.list;
const say = (key, values = {}) => data.words[key].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const shaped = row => ({ proposal_id: row.id, ...row.values });

const rowOf = async (lists, id) => {
  if (typeof id !== 'string' || !id.trim() || id.includes('/')) throw new TaskProposalError(say('bad_id'));
  const row = await lists.row(LIST.id, id.trim());
  if (!row) throw new TaskProposalError(say('no_proposal', { id }));
  return row;
};

/** GET ?proposal_id= | ?state= | ?cursor=: the proposals, or one of them. Changes nothing. */
export async function readTaskProposals(lists, input = {}) {
  if (!(await lists.has(LIST.id))) return { proposals: [], page: { complete: true, next_cursor: null } };
  if (typeof input.proposal_id === 'string' && input.proposal_id) return { proposal: shaped(await rowOf(lists, input.proposal_id)) };
  const wanted = typeof input.state === 'string' ? input.state : null;
  const page = await lists.read(LIST.id, { limit: 50, ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}) });
  return { proposals: page.rows.map(shaped).filter(item => !wanted || item.state === wanted), page: { complete: page.page.complete, next_cursor: page.page.next_cursor } };
}

/** The route: GET /calendar/task-proposals reads. Any other method is refused; keeping moved to the recipe. */
export async function handleTaskProposalRequest(lists, request) {
  try {
    const url = new URL(request.url);
    if (request.method === 'GET') return Response.json(await readTaskProposals(lists, Object.fromEntries(url.searchParams)));
    return Response.json({ error: 'Method not allowed.' }, { status: 405 });
  } catch (error) {
    return Response.json({ error: String(error?.message ?? error) }, { status: error instanceof CalendarTasksError ? 400 : 500 });
  }
}

export const isTaskProposalPath = path => path === '/calendar/task-proposals';
