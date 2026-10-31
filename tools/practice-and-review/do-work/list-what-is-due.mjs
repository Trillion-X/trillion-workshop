// tools/practice-and-review/do-work/list-what-is-due.mjs
//
// What a person should review now, worked out from the items and the grades they have given them. Run by the Workshop
// tool `tool:list-what-is-due` in the tool container:
//
//   node do-work/list-what-is-due.mjs < <the input as JSON>
//
// and prints { now, due_count, items } as JSON on its last line, due items first. A due time is never stored: it is folded
// from the item's grades each time, so the grades are the only record and the queue cannot drift from them. The policy is
// `policy`, or the first of `rows` whose kind is `policy_kind`; this tool has none of its own.
import { text } from 'node:stream/consumers';
import { dueQueueFromResponses, parseTime, policyFromRows } from '../read-data/review-schedule.mjs';

const input = JSON.parse((await text(process.stdin)) || '{}');
if (!Array.isArray(input.prompts)) throw new Error('prompts is required: the items to review, each { id, text? }');
const now = input.now ?? new Date().toISOString();
const items = dueQueueFromResponses({
  prompts: input.prompts,
  responses: input.responses ?? [],
  nowMs: parseTime(now, 'now'),
  policy: input.policy ?? (input.rows ? policyFromRows(input.rows, input.policy_kind) : null) ?? undefined,
  learner: input.learner,
});
console.log(JSON.stringify({ now, due_count: items.filter(item => item.is_due).length, items }));
