import { buildStandRequest } from '../do-work/stand-request.mjs';
import { foldRankedRecordReviewProjection } from '../read-data/ranked-record-review-projection.js';

export function consumeRankedReviewForJsCore({ descriptor, records, related, actionContext }) {
  const projection = foldRankedRecordReviewProjection({ descriptor, records, related });
  const firstAction = projection.rows[0]?.actions[0];
  const request = firstAction?.stance
    ? buildStandRequest({ ...firstAction, lookup: { row: projection.rows[0], input: actionContext ?? {} } })
    : null;
  console.log('[suggested-match] jscore projection consumed', { rowCount: projection.rows.length });
  if (request) console.log('[suggested-match] jscore stand request built', { row_ref: projection.rows[0].recordId });
  return { projection, request };
}
