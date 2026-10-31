// tools/rank-records-for-review/do-work/rank-records-for-review.mjs
//
// tool:rank-records-for-review: one JSON request on standard input,
//   { descriptor, records, related?, stands?, events?, cursor? }
// and { result: { projectionId, source, cursor, rows, proof } } as JSON on the last line. `events` (upsert and delete,
// each with a cursor) are applied over `records` first, as the maintained state does. `stands` are the person's stance
// records (their values, as records:list or tool:read-where-you-stand gives them). A request it cannot fold is refused
// with { error } and why.
import { text } from 'node:stream/consumers';
import { applyRankedReviewEvents, createRankedReviewState, snapshotRankedReviewProjection } from '../read-data/rank-records-for-review.mjs';

try {
  const input = JSON.parse((await text(process.stdin)) || '{}');
  const state = applyRankedReviewEvents(createRankedReviewState(input.records ?? []), input.events ?? []);
  if (typeof input.cursor === 'string') state.cursor = input.cursor;
  console.log(JSON.stringify({ result: snapshotRankedReviewProjection({ state, descriptor: input.descriptor, related: input.related ?? [], stands: input.stands ?? [] }) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
