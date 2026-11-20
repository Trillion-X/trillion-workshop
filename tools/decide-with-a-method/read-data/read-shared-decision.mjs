// tools/decide-with-a-method/read-data/read-shared-decision.mjs
//
// PURPOSE
//   tool:read-shared-decision: the anonymous shared entry a person's decision was kept as (tool:share-a-decision writes it
//   on the decision's root as `shared`). Read beside the share, so the share's own row is the only place the entry is kept.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only the entry the share kept is returned: its five shared fields and the review identity it was checked under. No
//      goal, evidence, person or account field is read or returned.
//   2. A decision that was never shared is refused, never answered with an empty entry.
import { decisionId, decisionOrRefuse } from './decisions.mjs';
import { recordsIn } from './decision-records.mjs';

/**
 * tool:read-shared-decision. input { decision_id, records }: the decision's records as the caller read them. Answers
 * { case_id, shared: { entry, review_identity, at } }.
 */
export function readSharedDecision(input) {
  const held = recordsIn(input);
  const id = decisionId(input);
  const record = decisionOrRefuse(held, id);
  if (!record.shared) throw new Error('This decision has no shared entry: it was never shared.');
  const { entry, review_identity: reviewIdentity, at } = record.shared;
  return { case_id: id, shared: { entry, review_identity: reviewIdentity, at } };
}
