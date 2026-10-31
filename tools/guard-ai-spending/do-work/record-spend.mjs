#!/usr/bin/env node
//
// THE SPEND-LEDGER REDUCER (pure function):
//   record_spend(wallet_rows, spend) -> { total_spent_today, total_spent_all_time, payment_record }
//
// This is the ONLY place the spend totals are incremented. It exists as a
// compute.process step because the engine has NO arithmetic binding op — the
// increment (current + amount) is real addition over integer minor units.
//
// NON-NEGOTIABLE invariants (1000x):
//   - INTEGER minor units of USD (cents) throughout — no float drift.
//   - LIVE-LOG READ PATH: the prior totals arrive as read-current value_json (the
//     workflow reads each by address via engine.operation.read-current). Live-log facts
//     are NOT in the find-current-items projection. Absent -> 0.
//   - PURE: reads current totals + amount, returns new totals + a payment_processed
//     audit record. The CALLER does the write (this never touches the log).
//   - This runs AFTER a payment has actually succeeded. It records reality; it never
//     authorizes. Authorization is the budget-gate's job (decide-budget.mjs).
//
// Contract (positional — process.argv[2..] under `node record-spend.mjs ...`):
//   argv[2] = output path for the ledger JSON
//   argv[3] = total_spent_today    value_json (read-current of that prop; absent -> 0)
//   argv[4] = total_spent_all_time value_json (read-current of that prop; absent -> 0)
//                  Live-log facts are read via engine.operation.read-current, NOT
//                  find-current-items (which only sees the package-admission projection).
//   argv[5] = spend JSON text        ({ amount, operation_ref, spend_authority_ref?,
//                                       rail_ref?, wallet_ref?, spender_id?, agent_id?,
//                                       facilitator_response?, payment_ref? })
//   argv[6] = now ISO string         (wall-clock from a sibling process step; optional)
//
// stdout / output file:
//   {
//     "total_spent_today":    <int>,   // previous today + amount
//     "total_spent_all_time": <int>,   // previous all-time + amount
//     "amount":               <int>,
//     "payment_record": { ... spend_payment_processed record payload ... }
//   }
//
// Exit code 0 on a well-formed ledger update; non-zero only on malformed input.

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

// Parse a read-current value_json (a JSON-encoded scalar) — live-log facts are read
// via engine.operation.read-current, NOT find-current-items. Empty/absent -> undefined.
function parseFactValue(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === 'null') return undefined;
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return raw;
  }
}

function asInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number') return Math.trunc(value);
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asString(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function main() {
  const outPath = process.argv[2];
  if (!outPath) throw new Error('argv[2] output path is required');

  // Wallet totals arrive as read-current value_json (argv[3..4]); live-log facts are read
  // by address, not via find-current-items. Absent -> 0.
  const prevToday = asInt(parseFactValue(process.argv[3]), 0);
  const prevAllTime = asInt(parseFactValue(process.argv[4]), 0);
  const spend = readJsonArg(process.argv[5], 'spend');
  const nowIsoArg = process.argv[6];

  const amount = asInt(spend.amount, 0);
  if (amount < 0) throw new Error(`spend amount must be >= 0, got ${amount}`);

  const operationRef = asString(spend.operation_ref, '');
  const spendAuthorityRef = asString(
    spend.spend_authority_ref,
    asString(spend.wallet_ref, 'spend-authority:unspecified'),
  );
  const railRef = asString(spend.rail_ref, 'payment-rail:unspecified');
  const spenderId = asString(spend.spender_id, asString(spend.agent_id, ''));
  const paymentRef = asString(spend.payment_ref, '') || `spend:${operationRef || 'operation'}:${Date.now()}`;
  const nowIso = asString(spend.now_iso, asString(nowIsoArg, new Date().toISOString()));

  const newToday = prevToday + amount;
  const newAllTime = prevAllTime + amount;

  const paymentRecord = {
    kind: 'spend_payment_processed',
    payment_ref: paymentRef,
    operation_ref: operationRef,
    spend_authority_ref: spendAuthorityRef,
    wallet_ref: spendAuthorityRef, // compatibility for current readers
    rail_ref: railRef,
    spender_id: spenderId,
    agent_id: spenderId, // compatibility for current readers
    amount,
    currency: 'USD',
    total_spent_today_after: newToday,
    total_spent_all_time_after: newAllTime,
    facilitator_response: spend.facilitator_response !== undefined ? spend.facilitator_response : null,
    processed_at: nowIso,
    evidence_refs: [spendAuthorityRef, railRef],
  };

  const ledger = {
    total_spent_today: newToday,
    total_spent_all_time: newAllTime,
    amount,
    payment_record: paymentRecord,
  };

  const text = JSON.stringify(ledger);
  fs.writeFileSync(outPath, text);
  process.stdout.write(text);
}

try {
  main();
} catch (err) {
  process.stderr.write(`record-spend error: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
}
