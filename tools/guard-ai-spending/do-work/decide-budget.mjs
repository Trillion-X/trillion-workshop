#!/usr/bin/env node
//
// THE BUDGET REDUCER (pure function):
//   decide_budget(wallet_rows, request) -> { approved, budget_check, budget_reservation, reason }
//
// This is the ONLY place the spend-gate DECISION-AS-MATH happens. It exists as a
// compute.process step because the workflow-core engine has NO branch step and NO
// arithmetic binding ops — so every numeric/conditional spend decision lives here,
// as a pure, deterministic, side-effect-free function over self-describing inputs.
//
// NON-NEGOTIABLE invariants (1000x):
//   - NO closed enums. wallet.status / result / reservation.status are OPAQUE strings
//     read from data and passed through. New states need ZERO code change here.
//   - NO Society vocabulary baked in. This reducer knows "amounts, limits, thresholds,
//     a status string, an enabled flag" — not "x402" or any specific payment protocol.
//     The operation_ref / wallet_ref are opaque data carried through.
//   - All money is in INTEGER MINOR UNITS of USD (cents) to avoid float drift. The
//     wallet's daily_limit / per_transaction_limit / total_spent_today and the
//     request's estimated_cost are all integer USD cents.
//   - LIVE-LOG READ PATH: each wallet property arrives as the value_json of an
//     engine.operation.read-current step. Live-log-written facts (engine.operation.
//     write-batch) are readable via read-current at their identity address — but they
//     are NOT in the slot::find-current-items projection (that index is populated by
//     the package-admission pipeline, not by write-batch). The gate therefore reads
//     each wallet property by address, not by query. Empty/absent -> fail-closed.
//   - The gate is a STRUCTURAL pre-operation step: it WRITES a budget_check +
//     budget_reservation the caller must carry forward; if denied, the caller
//     blocks. This script never performs the payment — it only authorizes (or denies).
//
// Contract (positional — process.argv[2..] under `node decide-budget.mjs ...`):
//   argv[2]  = output path for the decision JSON
//   argv[3]  = wallet status      value_json (read-current of prop:connection:status)
//   argv[4]  = wallet enabled     value_json (read-current of prop:connection:enabled)
//   argv[5]  = wallet daily_limit value_json (read-current of prop:connection:daily_limit)
//   argv[6]  = wallet per_transaction_limit value_json (read-current of that prop)
//   argv[7]  = wallet total_spent_today      value_json (read-current of that prop)
//                  Each wallet value is the value_json of an engine.operation.read-current
//                  step — live-log facts are read this way, NOT via find-current-items
//                  (which only sees the package-admission projection). Empty/absent ->
//                  fail-closed defaults (status=pending_setup, enabled=false, 0s).
//   argv[8]  = request JSON text  ({ operation_ref, estimated_cost, spend_authority_ref?,
//                  rail_ref?, wallet_ref?, spender_id?, agent_id?, idempotency_key?, ttl_seconds? })
//   argv[9]  = now ISO string     (the wall-clock 'now' from a sibling process step;
//                                  workflow bindings have no clock. Optional — falls back
//                                  to the script's own Date.now() and to request.now_iso.)
//   argv[10] = existing reservation JSON ({} or null when none) — read-current of the
//                                  per-operation budget-reservation address. Drives
//                                  IDEMPOTENCY: a still-current reservation for the same
//                                  idempotency_key short-circuits to an idempotent
//                                  admission (no duplicate reservation or double-count).
//
// stdout / output file:
//   {
//     "approved": bool,
//     "reason":   "ok" | "zero_cost" | "wallet_disabled" | "wallet_not_active" | "invalid_amount"
//               | "over_daily_limit" | "over_per_transaction_limit",
//     "budget_check":       { ... spend_budget_check record payload (result approved|denied) ... },
//     "budget_reservation": { ... spend_budget_reservation record payload (status current|denied) ... },
//     "spend_snapshot":     { total_spent_today, total_spent_after, daily_limit, per_transaction_limit }
//   }
//
// Exit code is ALWAYS 0 on a well-formed decision (approved OR denied) — a non-zero
// exit is reserved for malformed input, so the workflow can distinguish "denied" (a
// valid business outcome carried in the payload) from "the gate itself broke".

import fs from 'node:fs';

function readJsonArg(raw, label) {
  if (raw === undefined || raw === null || raw === '') {
    throw new Error(`missing required JSON argument: ${label}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`argument ${label} is not valid JSON: ${err.message}`);
  }
}

function asInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number') return Math.trunc(value);
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return fallback;
}

function asString(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

// Parse a single read-current value: the workflow passes each wallet property as the
// `value_json` of an engine.operation.read-current step (a JSON-encoded scalar, e.g.
// "\"active\"", "100", "false"), or empty/"null" when the fact is absent. Returns the
// decoded value, or undefined so the caller applies its own fail-closed default.
function parseFactValue(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === 'null') return undefined;
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return raw; // already a bare scalar
  }
}

function main() {
  const outPath = process.argv[2];
  if (!outPath) throw new Error('argv[2] output path is required');

  // --- Wallet config: each property arrives as a read-current value_json (live-log
  // facts are read via engine.operation.read-current, NOT find-current-items which only
  // sees the package-admission projection). argv[3..7], fail-closed defaults. ---
  const status = asString(parseFactValue(process.argv[3]), 'pending_setup');
  const enabled = asBool(parseFactValue(process.argv[4]), false);
  const dailyLimit = asInt(parseFactValue(process.argv[5]), 0);
  const perTransactionLimit = asInt(parseFactValue(process.argv[6]), 0);
  const totalSpentToday = asInt(parseFactValue(process.argv[7]), 0);

  const request = readJsonArg(process.argv[8], 'request');
  const nowIsoArg = process.argv[9]; // optional wall-clock from a sibling process step
  // argv[10] = the existing per-operation reservation (read-current of
  // package::agent-wallet::budget-reservation::<op>), or {} / null when none exists.
  // Used for IDEMPOTENCY: a still-current reservation for the same idempotency_key is
  // an already-authorized spend — re-running must NOT re-approve or double-count.
  let existingReservation = null;
  if (process.argv[10] !== undefined && process.argv[10] !== '') {
    try {
      const parsed = JSON.parse(process.argv[10]);
      existingReservation = parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0 ? parsed : null;
    } catch (_err) {
      existingReservation = null;
    }
  }

  // --- Resolve the request ---
  const operationRef = asString(request.operation_ref, '');
  const spendAuthorityRef = asString(
    request.spend_authority_ref,
    asString(request.wallet_ref, 'spend-authority:unspecified'),
  );
  const railRef = asString(request.rail_ref, 'payment-rail:unspecified');
  const spenderId = asString(request.spender_id, asString(request.agent_id, ''));
  const estimatedCost = asInt(request.estimated_cost, Number.NaN);
  // Resolve a wall-clock anchor that NEVER throws: prefer request.now_iso, then the
  // argv now string, then the script's own clock. An unparseable value (empty / bad)
  // falls back to Date.now() so check/reservation expiry math can't crash the gate.
  const nowCandidate = asString(request.now_iso, '') || asString(nowIsoArg, '');
  const nowMs = Number.isFinite(Date.parse(nowCandidate)) ? Date.parse(nowCandidate) : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const ttlSeconds = asInt(request.ttl_seconds, 300);
  const idempotencyKey =
    asString(request.idempotency_key, '') ||
    `idem:${operationRef || 'operation'}:${nowIso}`;

  const expiresAt = new Date(nowMs + ttlSeconds * 1000).toISOString();
  const totalSpentAfter = totalSpentToday + estimatedCost;

  // --- IDEMPOTENCY short-circuit (prevents concurrent/repeat reservations against a
  // stale total_spent_today). If a still-current reservation for the SAME
  // idempotency_key already exists and has not expired, this spend was already
  // authorized — return that prior reservation unchanged with idempotent:true. The
  // caller carries it forward exactly as the first call would have, and record-spend
  // is keyed by the same idempotency so the amount is never double-counted. ---
  if (
    existingReservation &&
    existingReservation.status === 'current' &&
    asString(existingReservation.idempotency_key, '') === idempotencyKey &&
    Number.isFinite(Date.parse(existingReservation.expires_at)) &&
    Date.parse(existingReservation.expires_at) > Date.parse(nowIso)
  ) {
    const priorAmount = asInt(existingReservation.amount, 0);
    const idempotentCheck = {
      kind: 'spend_budget_check',
      check_ref: `spend-budget-check:${operationRef || 'operation'}`,
      operation_ref: operationRef,
      spend_authority_ref: spendAuthorityRef,
      wallet_ref: spendAuthorityRef, // compatibility for current readers
      rail_ref: railRef,
      spender_id: spenderId,
      agent_id: spenderId, // compatibility for current readers
      idempotency_key: idempotencyKey,
      result: 'approved',
      denied_reason: '',
      estimated_cost: priorAmount,
      currency: 'USD',
      spend_snapshot_ref: `spend-authority-snapshot:${operationRef || 'operation'}`,
      checked_at: nowIso,
      expires_at: existingReservation.expires_at,
      evidence_refs: [spendAuthorityRef, railRef],
    };
    const decision = {
      approved: true,
      reason: 'idempotent_existing_reservation',
      idempotent: true,
      budget_check: idempotentCheck,
      budget_reservation: existingReservation,
      spend_snapshot: {
        total_spent_today: totalSpentToday,
        total_spent_after: totalSpentToday, // no new spend — already counted
        daily_limit: dailyLimit,
        per_transaction_limit: perTransactionLimit,
      },
    };
    const text = JSON.stringify(decision);
    fs.writeFileSync(outPath, text);
    process.stdout.write(text);
    return;
  }

  // --- The gate (ordered, fail-closed) ---
  let approved = true;
  let reason = 'ok';
  if (!Number.isInteger(estimatedCost) || estimatedCost < 0) {
    approved = false;
    reason = 'invalid_amount';
  } else if (estimatedCost === 0) {
    // A zero-cost operation still receives the same auditable check + fencing
    // reservation, but it cannot consume wallet authority or require a funded
    // payment rail. Guard and permission owners remain independent hard gates.
    approved = true;
    reason = 'zero_cost';
  } else if (!enabled) {
    approved = false;
    reason = 'wallet_disabled';
  } else if (status !== 'active') {
    approved = false;
    reason = 'wallet_not_active';
  } else if (dailyLimit > 0 && totalSpentAfter > dailyLimit) {
    approved = false;
    reason = 'over_daily_limit';
  } else if (perTransactionLimit > 0 && estimatedCost > perTransactionLimit) {
    // Exceeding the automatic per-transaction safety limit is a complete denial,
    // never a person-approval state.
    approved = false;
    reason = 'over_per_transaction_limit';
  }

  const checkRef = `spend-budget-check:${operationRef || 'operation'}`;
  const reservationRef = `spend-budget-reservation:${operationRef || 'operation'}`;
  const spendSnapshotRef = `spend-authority-snapshot:${operationRef || 'operation'}`;
  const fencingToken = `spend-authority-budget-fence:${idempotencyKey}`;

  const budgetCheck = {
    kind: 'spend_budget_check',
    check_ref: checkRef,
    operation_ref: operationRef,
    spend_authority_ref: spendAuthorityRef,
    wallet_ref: spendAuthorityRef, // compatibility for current readers
    rail_ref: railRef,
    spender_id: spenderId,
    agent_id: spenderId, // compatibility for current readers
    idempotency_key: idempotencyKey,
    result: approved ? 'approved' : 'denied',
    denied_reason: approved ? '' : reason,
    estimated_cost: estimatedCost,
    currency: 'USD',
    spend_snapshot_ref: spendSnapshotRef,
    checked_at: nowIso,
    expires_at: expiresAt,
    evidence_refs: [spendAuthorityRef, railRef],
  };

  // The reservation is the double-spend fencing record. It is ALWAYS emitted (never
  // null) so the downstream write step always has a real payload to persist — a
  // null payload is an ambiguous write (could tombstone the fixed mirror). On
  // admission it is `current` with the reserved amount; on denial it is `denied`
  // with amount 0 (the denied reservation IS the audit record). status is an OPEN
  // string — adding `denied` to the set {current,expired,claimed,failed} needs zero
  // code change. The caller decides proceed/block on budget_check.result, NOT on
  // reservation presence.
  const budgetReservation = {
    kind: 'spend_budget_reservation',
    reservation_ref: reservationRef,
    operation_ref: operationRef,
    spend_authority_ref: spendAuthorityRef,
    wallet_ref: spendAuthorityRef, // compatibility for current readers
    rail_ref: railRef,
    spender_id: spenderId,
    agent_id: spenderId, // compatibility for current readers
    idempotency_key: idempotencyKey,
    spend_snapshot_ref: spendSnapshotRef,
    fencing_token: fencingToken,
    status: approved ? 'current' : 'denied',
    denied_reason: approved ? '' : reason,
    amount: approved ? estimatedCost : 0,
    currency: 'USD',
    reserved_at: nowIso,
    expires_at: expiresAt,
    evidence_refs: [checkRef],
  };

  const decision = {
    approved,
    reason,
    idempotent: false,
    budget_check: budgetCheck,
    budget_reservation: budgetReservation,
    spend_snapshot: {
      total_spent_today: totalSpentToday,
      total_spent_after: totalSpentAfter,
      daily_limit: dailyLimit,
      per_transaction_limit: perTransactionLimit,
    },
  };

  const text = JSON.stringify(decision);
  fs.writeFileSync(outPath, text);
  process.stdout.write(text);
}

try {
  main();
} catch (err) {
  process.stderr.write(`decide-budget error: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
}
