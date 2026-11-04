// src/behavior-routing.mjs
//
// Purpose: which operations of an account's own records go to the behavior owner (src/standalone-resource-behavior.mjs)
// and which stay with the small table of operations the book mounts itself (src/record-book-own-resource.mjs).
//
// Invariant: the behavior's own action registry decides. An operation it declares goes to it, so a family added to the
// registry routes with no edit here. An earlier hand-kept list of families left `workForAis:facts` out, and every
// delivery of Trillion's work to an AI failed with "This resource operation is not installed" (2026-10-20).
import { isOwnerRouteOperation } from './native-owner-routes.mjs';

export const routesToBehavior = (behavior, operation) => operation !== 'resource:create' && Boolean(behavior)
  && (behavior.declares?.(operation) === true || isOwnerRouteOperation(operation) || /^input:(weighSaidDone|reclassify)$/.test(operation));
