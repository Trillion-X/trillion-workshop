// tools/rank-records-for-review/do-work/stand-request.mjs
//
// Purpose
//   Turns the person's accept or pass on one ranked row into the request tool:keep-where-you-stand
//   (tools/where-a-person-stands) takes, so their decision is kept by the one owner of stands, as a stand of the row's
//   kind on the row's view. This file writes nothing and sends nothing; the caller runs that tool with the request.
//
// Non-negotiable invariants
//   1. The stance comes from the action's DATA (`stance`: agree for accept, disagree for pass, or any stand that owner
//      keeps); `answered_by` is always "person": a stand is only ever theirs.
//   2. Copy rules (`copy: [{ key, from | value }]`) read only from the row (`row.<path>`) or the caller's input
//      (`input.<path>`) and may set only the fields of a stand a caller gives (why, by, at). Anything else is refused.
//      Why only those three: the old copy rules filled an open input bag, but the keeper's input takes exactly the
//      thing stood on (kind, view), the stance, answered_by and these three, and refuses any other key; a copy into
//      another key could only ever make a request the keeper refuses, or, worse, one that overwrote what the row names.
//      So the list is the keeper's own list, not a choice made here.
//   3. A disabled action is refused with its own reason before any request is built.
//   4. The request carries the refs the old request carried, made the same way every time: row_ref, idempotency_ref
//      (row ref or record ref, action id, the words copied, and the time of the stand's newest version on the row) and request_ref (the caller's, else the idempotency_ref).
//      A stand already on the row with the same stance and words makes `unchanged` true.
//
// Ported from bitfield-packages packages/suggested-match/do-work/owner-action-request.js: the lookup bag, the copy rules,
// the request, row and idempotency refs and the disabled refusal are the same. Changed: the request is a
// keep-where-you-stand input instead of an old engine workflow target, the `session` lookup root (the old runtime's
// process session) is gone, and the sender callback is gone (the Workshop runs one tool at a time; the caller runs the
// next). The old idempotency_ref was copied from the record by a descriptor rule; here it is always made, from the
// record's own `idempotency_ref` when it has one, so no descriptor can forget it.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { isPlainRecord, readPath } from '../read-data/rank-records-for-review.mjs';

// The fields of a stand a caller may give, beyond the thing and the stance (tool:keep-where-you-stand's input).
const STAND_FIELDS = ['why', 'by', 'at'];

function readFromLookup(lookup, source) {
  if (typeof source !== 'string' || source.length === 0) return undefined;
  const parts = source.split('.').filter(Boolean);
  const root = parts.shift();
  if (root === 'row') return readPath(lookup.row, parts);
  if (root === 'input') return readPath(lookup.input ?? {}, parts);
  return undefined;
}

function copiedInput(action, lookup) {
  const copied = {};
  for (const entry of Array.isArray(action?.copy) ? action.copy : []) {
    if (!STAND_FIELDS.includes(entry?.key)) {
      throw new Error(`Action ${action.id} copies ${entry?.key}; a stand takes only ${STAND_FIELDS.join(', ')}.`);
    }
    const value = entry.from ? readFromLookup(lookup, entry.from) : entry.value;
    if (value !== undefined) copied[entry.key] = value;
  }
  return copied;
}

function splitActionRequest(actionRequest) {
  if (!isPlainRecord(actionRequest)) return { action: actionRequest, lookup: {} };
  const { lookup, ...action } = actionRequest;
  return { action, lookup: isPlainRecord(lookup) ? lookup : {} };
}

// The words of a stand as the keeper keeps them: `why` is kept only when it has a word in it.
const whyOf = value => (typeof value === 'string' && value.trim() ? value : '');

// The same act, asked twice on the same row as it stood, has the same ref: the row's own ref (or its record ref), the
// action, what the person gave (if anything) and the time of the stand's newest version on the row (if there is one).
// Accept, pass, accept again is three acts: the third sees the pass the second kept, so its ref differs from the first.
// Nothing is hashed, so the ref can be read and compared by eye.
function idempotencyRefFor(row, action, copied) {
  const base = `${row.idempotencyRef ?? row.recordId}:${action.id}`;
  const worded = Object.keys(copied).length ? `${base}:${encodeURIComponent(JSON.stringify(copied))}` : base;
  return row.standVersion ? `${worded}@${encodeURIComponent(row.standVersion)}` : worded;
}

/**
 * One request object: the action as the fold gave it, with its lookup bag ({ row, input, requestRef? }) under `lookup`.
 * Returns { tool: "tool:keep-where-you-stand", row_ref, idempotency_ref, request_ref, unchanged,
 * input: { kind, view, stance, answered_by: "person", why?, by?, at? } }.
 *   - idempotency_ref: the same row as it stands, action and words give the same ref, so a caller that sees a ref it has
 *     already run does not keep the stand twice (a second run would make a second version of the stance record). The
 *     version of the stand on the row (`row.standVersion`: its newest time, else its place in the history) is in the ref, so a change the person made
 *     since (accept, pass, accept again) is a new act and is kept.
 *   - request_ref: the caller's own (`lookup.requestRef`), else the idempotency_ref.
 *   - unchanged: true when the stands given to the fold already say this stance with these words on this row; the caller
 *     has nothing to keep. The request is still returned in full.
 * `input` is the keeper's whole input; the three refs and `unchanged` are for the caller and are not sent to it.
 */
export function buildStandRequest(actionRequest) {
  const { action, lookup } = splitActionRequest(actionRequest);
  if (!isPlainRecord(action)) throw new Error('Action descriptor is required.');
  if (typeof action.id !== 'string' || action.id.length === 0) throw new Error('Action descriptor requires id.');
  if (action.enabled === false) throw new Error(action.disabledReason ?? 'Action is disabled.');
  if (typeof action.stance !== 'string' || action.stance.length === 0) throw new Error(`Action ${action.id} names no stance.`);
  const row = lookup.row ?? {};
  if (!isPlainRecord(row.standView) || typeof row.standKind !== 'string') {
    throw new Error('The row must come from the fold: it carries standKind and standView.');
  }
  const copied = copiedInput(action, lookup);
  const idempotencyRef = idempotencyRefFor(row, action, copied);
  return {
    tool: 'tool:keep-where-you-stand',
    row_ref: row.recordId,
    idempotency_ref: idempotencyRef,
    request_ref: typeof lookup.requestRef === 'string' && lookup.requestRef ? lookup.requestRef : idempotencyRef,
    unchanged: Boolean(row.stand) && row.stand.stance === action.stance && whyOf(row.stand.why) === whyOf(copied.why),
    input: {
      kind: row.standKind,
      view: row.standView,
      stance: action.stance,
      answered_by: 'person',
      ...copied,
    },
  };
}
