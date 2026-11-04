// tools/keep-goals-and-focus/read-data/order-goals.mjs
//
// A person's goals put in the order they are shown, each under the goal it serves, by the same reader the app's goal
// list uses (pursuit-hierarchy-view.mjs): a goal with several parents is still one goal and one row, indented under
// the first parent reached in the shown order, and a goal whose parent is missing or that sits in a cycle is still
// shown. Pure: it reads only the goals given.
//
// Input:
//   goals  [{ id, title?, parents?, children? }]   parents and children: goal ids (or { id }); a goal's own parents
//                                                  win over another goal's children list
// Answers { rows: [{ id, title, depth, shown_under, parents }], count } (shown_under: the goal it is indented under, or
// null; parents: every parent it names that is among the goals given).
// Refused: goals that is not a list, or a goal without an id.
import { pursuitHierarchyRows } from './pursuit-hierarchy-view.mjs';

export function orderGoals({ goals } = {}) {
  if (!Array.isArray(goals)) throw new Error('Give goals: a list of { id, title?, parents?, children? }.');
  goals.forEach((goal, index) => {
    if (!goal || typeof goal !== 'object' || typeof goal.id !== 'string' || !goal.id) throw new Error(`Goal ${index} needs id: a non-empty string.`);
  });
  const rows = pursuitHierarchyRows(goals).map(({ record, depth, displayParentId, parents }) => ({
    id: record.id,
    title: typeof record.title === 'string' ? record.title : null,
    depth,
    shown_under: displayParentId,
    parents: parents.map(parent => parent.id),
  }));
  return { rows, count: rows.length };
}
