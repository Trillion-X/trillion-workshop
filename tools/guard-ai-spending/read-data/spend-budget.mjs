// tools/guard-ai-spending/read-data/spend-budget.mjs
//
// The tools that keep an AI's own spending inside the budget its person set, over the person's own records through
// the run's records door (tools/records-door). Each one reads the records it needs, runs the package's pure
// decision script in do-work/ (copied unchanged), and writes what the script decided:
//
//   reserveSpendWithinBudget  tool:reserve-a-spend-within-budget  before a spend: check and reserve it, or deny it
//   maySpendGoAhead           tool:may-this-spend-go-ahead        just before paying: exactly one current reservation?
//   recordASpend              tool:record-a-spend                 after the money moved: add it to the totals, once
//   resetDailySpend           tool:reset-daily-spend              once a day (UTC): today's total back to zero
//   readSpendRails            tool:read-spend-rails               the rails that may pay, and the rows refused
//
// Records (the person's own; every amount whole cents):
//   spend-authority           <spend_authority_ref>               the limits the person set and the totals spent
//   spend-budget-check        spend-budget-check:<operation_ref>  the latest check of one operation
//   spend-budget-reservation  spend-budget-reservation:<op>       the fence that one operation's spend carries
//   spend-payment             <payment_ref>                       one spend that was paid
//   payment-rail              <rail id>                           a person's own rail row (replaces a shipped one)
//
// Fail-closed for money: no authority record, or one not enabled and active, denies every positive spend. The run's
// clock is the time; a caller cannot choose `now_iso`. No tool here raises a limit or turns an authority on: those are
// the person's to set, never their AI's.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import shipped from './spend-rails.json' with { type: 'json' };
import { readPaymentRails } from './spend-rails.ts';
import { budgetDecisionForOperation, decodeAgentBudgetAuthority } from './read-agent-budget-authority.ts';
import { SPEND_AUTHORITY_TYPE } from './spend-authority.ts';

export const CHECK_TYPE = 'spend-budget-check';
export const RESERVATION_TYPE = 'spend-budget-reservation';
export const PAYMENT_TYPE = 'spend-payment';
export const RAIL_TYPE = 'payment-rail';

const words = value => typeof value === 'string' && value.trim() !== '';

function required(input, names) {
  const missing = names.filter(name => !words(input?.[name]));
  if (missing.length) throw new Error(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} needed: name the spend authority and the operation, like { "spend_authority_ref": "spend-authority:research", "operation_ref": "operation:buy-a-report" }.`);
}

// A record field as the scripts read it: the JSON of the value, or empty when absent (the scripts' fail-closed default).
const fact = value => (value === undefined || value === null ? '' : JSON.stringify(value));

// The caller's request without the fields only the run decides.
function request(input) {
  const { now_iso: _now, ...rest } = input ?? {};
  return rest;
}

// Run one do-work script as its own process and wait without blocking this one: a blocked event loop keeps the
// records door's idle connection past its close, and the next door call then fails on a dead socket.
function runScript(name, args) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(`../do-work/${name}`, import.meta.url)), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', status => done({ status, stdout, stderr }));
  });
}

async function decided(name, args) {
  const run = await runScript(name, args);
  if (run.status !== 0) throw new Error(run.stderr.trim() || `${name} stopped with ${run.status}.`);
  return JSON.parse(run.stdout);
}

/** tool:reserve-a-spend-within-budget: the package's budget gate, its check and reservation written to the person's records. */
export async function reserveSpendWithinBudget(input, { door }) {
  required(input, ['spend_authority_ref', 'operation_ref']);
  const authority = await door.read(SPEND_AUTHORITY_TYPE, input.spend_authority_ref) ?? {};
  const existing = await door.read(RESERVATION_TYPE, `${RESERVATION_TYPE}:${input.operation_ref}`);
  const decision = await decided('decide-budget.mjs', [
    '/dev/null',
    fact(authority.status), fact(authority.enabled), fact(authority.daily_limit),
    fact(authority.per_transaction_limit), fact(authority.total_spent_today),
    JSON.stringify(request(input)), new Date().toISOString(), JSON.stringify(existing ?? {}),
  ]);
  if (!decision.idempotent) {
    await door.write([
      { id: decision.budget_check.check_ref, type: CHECK_TYPE, value: decision.budget_check },
      { id: decision.budget_reservation.reservation_ref, type: RESERVATION_TYPE, value: decision.budget_reservation },
    ], { key: `reserve:${decision.budget_check.idempotency_key}:${decision.budget_check.checked_at}` });
  }
  return decision;
}

/** tool:may-this-spend-go-ahead: the check and the one current reservation an operation must hold before it pays. */
export async function maySpendGoAhead(input, { door }) {
  required(input, ['spend_authority_ref', 'operation_ref', 'idempotency_key']);
  const records = (await Promise.all([
    door.read(CHECK_TYPE, `${CHECK_TYPE}:${input.operation_ref}`),
    door.read(RESERVATION_TYPE, `${RESERVATION_TYPE}:${input.operation_ref}`),
  ])).filter(Boolean).map(payload => ({ payload }));
  const decision = budgetDecisionForOperation(decodeAgentBudgetAuthority(records), input.operation_ref, input.idempotency_key, input.spend_authority_ref, new Date());
  return {
    available: decision.available,
    reason: decision.reason,
    amount: decision.reservation?.amount ?? 0,
    fencing_token: decision.available ? decision.reservation.fencingToken : null,
  };
}

/** tool:record-a-spend: the package's ledger step; one payment is added once, however often it is sent. */
export async function recordASpend(input, { door }) {
  required(input, ['spend_authority_ref', 'operation_ref']);
  if (!Number.isInteger(input.amount) || input.amount < 0) throw new Error('amount must be the whole cents that were paid, 0 or more.');
  const paymentRef = words(input.payment_ref) ? input.payment_ref : `spend:${input.operation_ref}`;
  const authority = await door.read(SPEND_AUTHORITY_TYPE, input.spend_authority_ref);
  if (!authority) throw new Error(`${input.spend_authority_ref} is not one of the person's spend authorities, so there is no total to add this spend to.`);
  const already = await door.read(PAYMENT_TYPE, paymentRef);
  if (already) {
    return { already_recorded: true, total_spent_today: authority.total_spent_today ?? 0, total_spent_all_time: authority.total_spent_all_time ?? 0, amount: already.amount, payment_record: already };
  }
  const ledger = await decided('record-spend.mjs', [
    '/dev/null', fact(authority.total_spent_today), fact(authority.total_spent_all_time),
    JSON.stringify({ ...request(input), payment_ref: paymentRef }), new Date().toISOString(),
  ]);
  await door.write([
    { id: input.spend_authority_ref, type: SPEND_AUTHORITY_TYPE, value: { ...authority, total_spent_today: ledger.total_spent_today, total_spent_all_time: ledger.total_spent_all_time } },
    { id: paymentRef, type: PAYMENT_TYPE, value: ledger.payment_record },
  ], { key: `record:${paymentRef}` });
  return { already_recorded: false, ...ledger };
}

/** tool:reset-daily-spend: today's total back to zero once per UTC day; a second run the same day changes nothing. */
export async function resetDailySpend(input, { door }) {
  if (!words(input?.spend_authority_ref)) throw new Error('spend_authority_ref is needed, like { "spend_authority_ref": "spend-authority:research" }.');
  const authority = await door.read(SPEND_AUTHORITY_TYPE, input.spend_authority_ref);
  if (!authority) throw new Error(`${input.spend_authority_ref} is not one of the person's spend authorities.`);
  const run = await runScript('decide-daily-reset.mjs', [JSON.stringify({ day: authority.last_reset_day })]);
  if (run.status !== 0 && run.status !== 3) throw new Error(run.stderr.trim() || `decide-daily-reset.mjs stopped with ${run.status}.`);
  const { should_reset: reset, day } = JSON.parse(run.stdout);
  if (reset) {
    await door.write([{ id: input.spend_authority_ref, type: SPEND_AUTHORITY_TYPE, value: { ...authority, total_spent_today: 0, last_reset_day: day } }], { key: `reset:${input.spend_authority_ref}:${day}` });
  }
  return { reset, day, total_spent_today: reset ? 0 : authority.total_spent_today ?? 0 };
}

/** tool:read-spend-rails: the shipped rails, each replaced by the person's own row of the same id, read through one contract. */
export async function readSpendRails(_input, { door }) {
  const rows = new Map(shipped.rails.map(row => [row.id, row]));
  for await (const record of door.list({ type: RAIL_TYPE })) rows.set(record.value?.id ?? record.id, record.value);
  const valid = readPaymentRails([...rows.values()]);
  const kept = new Set(valid.map(rail => rail.id));
  return {
    rails: valid.map(rail => ({ id: rail.id, label: rail.label, enabled: rail.enabled, spend_authority_ref: rail.spendAuthorityRef, credential_ref: rail.credentialRef, settles_with: rail.settlementInvoke.tool })),
    refused: [...rows.entries()].filter(([id]) => !kept.has(id)).map(([id]) => ({ id, why: `its guard must be tool:reserve-a-spend-within-budget and its ledger tool:record-a-spend, with a settlement tool, a credential name and an evidence contract` })),
  };
}
