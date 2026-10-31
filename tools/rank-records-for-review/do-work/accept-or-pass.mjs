// tools/rank-records-for-review/do-work/accept-or-pass.mjs
//
// tool:accept-or-pass-on-a-ranked-record: one JSON request on standard input,
//   { descriptor, record, action_id, input?, related?, stands? }
// folds the one record with the descriptor, takes the named action on its row, and prints
// { result: { tool: "tool:keep-where-you-stand", row_ref, idempotency_ref, request_ref, unchanged, input } } on the last
// line: the request that keeps the person's accept or pass as their stand (`input` is what that tool takes; the refs
// and `unchanged` are for the caller, who does not run it again for a ref it has run or when `unchanged` is true).
// It writes nothing. A record the descriptor does not show, an unknown or disabled action, or a copy
// rule that sets anything but why, by or at is refused with { error }.
import { text } from 'node:stream/consumers';
import { foldRankedRecordReviewProjection } from '../read-data/rank-records-for-review.mjs';
import { buildStandRequest } from './stand-request.mjs';

try {
  const input = JSON.parse((await text(process.stdin)) || '{}');
  const { rows } = foldRankedRecordReviewProjection({ descriptor: input.descriptor, records: [input.record], related: input.related ?? [], stands: input.stands ?? [] });
  if (!rows.length) throw new Error('The descriptor shows no row for this record (its filters leave it out).');
  const action = rows[0].actions.find(one => one.id === input.action_id);
  if (!action) throw new Error(`No action ${input.action_id} on this row; the actions are ${rows[0].actions.map(one => one.id).join(', ')}.`);
  console.log(JSON.stringify({ result: buildStandRequest({ ...action, lookup: { row: rows[0], input: input.input ?? {} } }) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
