// parts/timed-action/do-work/evaluate-due-scheduled-actions.ts (ported unchanged from bitfield-packages packages/timed-action/do-work)
// timed-action — the generic due-and-unfired evaluator for the scheduled-action
// graph. Blind and universal: it knows nothing about customers, feedback, or any feature
// domain. It consumes timed-action's OWN graph shape (the same separate arrays the
// display projection reads — records / time_windows / actions / receipts, joined by
// record_id) and returns exactly the action-fires that are DUE and NOT yet done. The
// clock is injected so the reduction is pure and deterministic. This is the reusable
// firing engine every scheduled follow-up shares (feedback sweep, re-engagement,
// renewal) — one primitive, N data configs.
//
// Alignment with the package SSOT:
//  - "due" matches read-scheduled-action-graph.ts `dueState`: a joined time-window whose
//    `start` (or `due_at`) is at or before `now`. No window => unscheduled => never fires.
//  - "already done" matches the real receipt writer buildScheduledActionStateWrite, which
//    stamps a receipt `{record_id, operation, ...}`. A fire is deduped by (record_id,
//    operation) — the action's `operation` (default action_id) is the discriminator, so
//    the same action never re-fires for the same record until its window advances.

function arr(v) {
  return Array.isArray(v) ? v : [];
}

// The action's operation discriminator — what a receipt records to say "this ran".
export function actionOperation(action) {
  return action?.operation ?? action?.action_id ?? null;
}

// The dedup key a receipt agrees with: (record_id, operation). Matches
// buildScheduledActionStateWrite's receipt payload {record_id, operation}.
export function receiptKey(record_id, operation) {
  // This is an internal comparison key, never a persisted receipt address.
  // Encode both components so a delimiter in one cannot suppress another job.
  return JSON.stringify([record_id ?? null, operation ?? null]);
}

// Resolve a joined time-window's due instant. Prefer an explicit `due_at`, else the
// window `start` (the projection's due basis). Missing => null (unscheduled).
export function resolveDueAt(window) {
  return window?.due_at ?? window?.start ?? null;
}

// The reduction. Input is the timed-action graph (records, time_windows, actions,
// receipts) + an injected `now` (ISO string; the clock-tick timestamp in production).
// Returns due-and-unfired action-fires carrying ONLY identity + the operation
// discriminator. The fire definition re-reads the scheduled-action-action row itself
// and dispatches the ask config THE ROW carries (`dispatch.name` + `dispatch.input`) —
// the evaluator never learns owner invocation shapes (row-carried dispatch doctrine).
// A row without `dispatch` is unscheduled work: it is never emitted (fail-closed).
export function evaluateDueScheduledActions(input = {}) {
  const timeWindows = arr(input.time_windows);
  const actions = arr(input.actions);
  const receipts = arr(input.receipts);
  const nowMs = input.now != null ? Date.parse(input.now) : Date.now();
  if (Number.isNaN(nowMs)) throw new Error('evaluate-due-scheduled-actions: `now` is not a parseable timestamp');

  // One window per record (last wins — mirrors the projection's byKey), keyed by record_id.
  const windowByRecord = new Map(timeWindows.filter((w) => w?.record_id != null).map((w) => [w.record_id, w]));
  const firedKeys = new Set(receipts.filter((r) => r?.record_id != null).map((r) => receiptKey(r.record_id, r.operation)));

  const due = [];
  for (const action of actions) {
    const recordId = action?.record_id;
    if (recordId == null) continue;
    const window = windowByRecord.get(recordId) || null;
    const dueAt = resolveDueAt(window);
    if (dueAt == null) continue; // unscheduled => never auto-fires (fail-closed)
    const dueMs = Date.parse(dueAt);
    if (Number.isNaN(dueMs) || nowMs < dueMs) continue; // malformed or not yet due

    const operation = actionOperation(action);
    if (firedKeys.has(receiptKey(recordId, operation))) continue; // already ran for this record

    // Fail-closed dispatch gate: a row that does not carry its own dispatch config is
    // unscheduled work — never fired, never receipted (row-carried dispatch doctrine).
    if (action.dispatch == null || action.dispatch.name == null) continue;

    due.push({
      record_id: recordId,
      operation,
      action_id: action.action_id ?? null,
      time_window_id: window?.time_window_id ?? null,
      due_at: dueAt,
      evaluated_at: new Date(nowMs).toISOString(),
    });
  }

  return {
    evaluated_at: new Date(nowMs).toISOString(),
    scanned_action_count: actions.length,
    already_fired_count: firedKeys.size,
    due_count: due.length,
    due,
  };
}
