// Settlement-to-provider reporting, using take-payments' existing Stripe request
// mapper and sender. The provider accepts an invoice item, not a new markup or a
// second usage computation. The settlement, the purchased agreement and the
// previous cash/applied-source state arrive in the request; the answer carries
// the frozen report and the next cash/applied-source state for the caller to keep.
// The invoice item is sent once under a key fixed by agreement, payer, currency,
// settlement and version, so the provider refuses to repeat it. No state here says paid.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { addAmounts, subtractAmounts, compareAmounts, rational, exactAmount, cashClearing } from '../read-data/resource-usage.mjs';
import { call } from '../../shared-code/src/build-provider-request.mjs';
import { heldKey, makeStripeSender } from './stripe-send.mjs';
export const usageReportingTypes = Object.freeze({ agreement: 'usage-billing-agreement', cash: 'resource-usage-cash', applied: 'resource-usage-applied-source', report: 'resource-usage-provider-report' });
const sorted = x => Array.isArray(x) ? x.map(sorted) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(key => [key, sorted(x[key])])) : x;
const canonical = x => JSON.stringify(sorted(x));
const hash = x => makeHashCodeHexFromBytes(new TextEncoder().encode(canonical(x)));
const word = (x, name) => { if (typeof x !== 'string' || !x.trim() || x.length > 512) throw new Error(`Give ${name} as nonempty text of at most 512 characters.`); return x; };
const expected = (type, value) => value === null ? null : { type, value };
const zero = { n: '0', d: '1' };
const RETRY_MS = 23 * 60 * 60 * 1000;
const customerId = value => typeof value === 'string' ? value : value?.id;

export function settlementCashPlan({ delta, carry = zero, currency_exponent, authorized_total }) {
  if (!Number.isInteger(currency_exponent) || currency_exponent < 0 || currency_exponent > 6) throw new Error('The pinned currency exponent must be an integer from 0 to 6.');
  const total = addAmounts(delta, carry); const signed = rational(total, 'accrued total', { signed: true });
  const sign = signed.n < 0n ? -1n : 1n; const magnitude = exactAmount({ n: signed.n * sign, d: signed.d });
  const quantum = { n: '1', d: (10n ** BigInt(currency_exponent)).toString() };
  const cleared = cashClearing({ amount: magnitude, quantum });
  if (compareAmounts(cleared.amount, authorized_total) > 0) throw new Error('The whole cash amount exceeds its current collection authorization; renew authority before reporting it.');
  const cash = rational(cleared.amount); const minor = cash.n * (10n ** BigInt(currency_exponent)) / cash.d;
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The cash amount exceeds the payment provider integer boundary.');
  return { amount: exactAmount({ n: cash.n * sign, d: cash.d }), carry: subtractAmounts(total, exactAmount({ n: cash.n * sign, d: cash.d })), accrued_total: total, minor_units: (minor * sign).toString() };
}

function pinnedAgreement(a, payer_id) {
  // The purchased agreement is handed in by the caller, read from the existing
  // agreement owner. It is a read projection, never a new editable grant.
  if (!a || a.state !== 'confirmed' || !a.source_ref || !a.authority_ref) throw new Error('Give a confirmed purchased billing agreement and its source/authority receipt before reporting usage.');
  for (const key of ['agreement_id', 'payer_id', 'provider_account_id', 'provider_customer_id', 'provider_subscription_id', 'currency']) word(a[key], key);
  if (a.payer_id !== payer_id || a.collection !== 'settled_invoice_item' || a.bill_usage !== true) throw new Error('This purchased agreement does not authorize this payer through the settled invoice-item path.');
  if (!Number.isInteger(a.currency_exponent) || a.currency_exponent < 0 || a.currency_exponent > 6) throw new Error('The agreement must pin the currency minor-unit precision.');
  rational(a.collection_authorized_total, 'collection authorization');
  if (!Array.isArray(a.usage_terms)) throw new Error('The agreement must carry its purchased resource terms.');
  return structuredClone(Object.fromEntries(['state', 'agreement_id', 'payer_id', 'provider_account_id', 'provider_customer_id', 'provider_subscription_id', 'currency', 'currency_exponent', 'usage_terms',
    'source_ref', 'authority_ref', 'bill_usage', 'collection', 'usage_billed_during_trial', 'collection_authorized_total', 'usage_description'].filter(key => a[key] !== undefined).map(key => [key, a[key]])));
}

function sourceAllocation(input) {
  const source = input.settlement?.settlement;
  if (!source || !Array.isArray(input.settlement.allocations)) throw new Error('Give settlement, the settlement and allocations a settlement answered, to report one version of it.');
  if (source.result.state !== 'reconciled') throw new Error('Only a reconciled and explicitly funded settlement can be reported.');
  const found = input.settlement.allocations.find(row => row.payer_id === input.payer_id && ['customer', 'removed'].includes(row.kind));
  if (!found) throw new Error('This settlement has no customer allocation for that payer.');
  return { source, allocation: structuredClone(found) };
}

const COMMITTED = ['provider_accepted', 'accrued_no_cash_report'];
function publicReport(value) {
  const committed = COMMITTED.includes(value.state);
  return { report_id: value.id, state: value.state, settlement_ref: value.settlement_ref, payer_id: value.payer_id, currency: value.agreement.currency,
    exact_delta: value.exact_delta, cash_amount: value.cash.amount, carry_after: committed ? value.cash.carry : null, planned_carry: value.cash.carry, provider_receipt: value.provider_receipt ?? null,
    payment_state: 'not_proved_collected', ...(value.state === 'reconciliation_required' ? { next_action: 'reconcile-resource-usage-report' } : {}) };
}
/** The answer: the report as the caller may show it, the frozen report to pass back for a retry or a reconciliation,
 * and the cash and applied-source state to pass to the next report once this one is committed (null until then). */
const answerOf = report => ({ ...publicReport(report), report, cash: report.cash_after ?? null, applied: report.applied_after ?? null });

/** Commit a report to its checkpoint: the exact carry and the cumulative source this report applied. */
function finishReport(report, providerReceipt = null) {
  const before = report.cash_before;
  const net = addAmounts(before?.net_reported ?? zero, report.cash.amount);
  if (compareAmounts(net, zero) < 0) throw new Error('A credit would exceed the cash previously reported for this agreement.');
  return { ...report, state: providerReceipt ? 'provider_accepted' : 'accrued_no_cash_report', provider_receipt: providerReceipt,
    cash_after: { version: (before?.version ?? 0) + 1, agreement_id: report.agreement.agreement_id, payer_id: report.payer_id, currency: report.agreement.currency,
      currency_exponent: report.agreement.currency_exponent, carry: report.cash.carry, net_reported: net, last_report: report.id },
    applied_after: { settlement_id: report.settlement_id, settlement_version: report.settlement_version, payer_id: report.payer_id, charged: report.source_charged, terms: report.purchased_terms, report_id: report.id } };
}

function sender(context) { return context.send ?? makeStripeSender({ key: heldKey(4, context.readKey) }); }
async function verifyBinding(send, agreement) {
  const account = await call(send, 'operation:read-stripe-account');
  if (account?.id !== agreement.provider_account_id) throw new Error('The mounted payment account is not the seller account pinned to this agreement.');
  const subscription = await call(send, 'operation:read-subscription', null, { ref: agreement.provider_subscription_id });
  if (subscription?.id !== agreement.provider_subscription_id || customerId(subscription.customer) !== agreement.provider_customer_id || subscription.currency !== agreement.currency) throw new Error('The provider subscription, customer or currency does not match the purchased agreement.');
  if (!['active', 'past_due', 'trialing'].includes(subscription.status)) throw new Error('This subscription cannot receive the usage line; resolve its final invoice in the payment owner before reporting.');
  if (subscription.status === 'trialing' && agreement.usage_billed_during_trial !== true) throw new Error('The purchased trial terms do not authorize usage charges during the trial.');
}
function receiptOf(provider, report) {
  const body = report.provider_subject;
  if (!provider || typeof provider.id !== 'string' || provider.object !== 'invoiceitem' || customerId(provider.customer) !== body.customer
    || String(provider.amount) !== body.amount || provider.currency !== body.currency || customerId(provider.subscription ?? provider.parent?.subscription_details?.subscription) !== body.subscription || provider.metadata?.usage_report_id !== report.id) throw new Error('The provider answer did not prove acceptance of this exact frozen usage line.');
  return { id: provider.id, object: provider.object, customer: body.customer, currency: body.currency, amount_minor: body.amount,
    subscription: body.subscription, usage_report_id: report.id, status: 'provider_accepted_invoice_item_not_paid' };
}
/** The cash and applied-source state handed in must be the state this report froze. */
function assertCheckpoint(report, input) {
  if (canonical(input.cash ?? null) !== canonical(report.cash_before) || canonical(input.applied ?? null) !== canonical(report.applied_before)) throw new Error('The cash/source checkpoint changed; give the cash and applied this report was prepared from.');
}

export async function reportResourceUsage(input, context) {
  const now = (context.now ?? Date.now)();
  const a = pinnedAgreement(input.agreement, input.payer_id); const { source, allocation } = sourceAllocation(input);
  const settlementId = source.id;
  const purchased = a.usage_terms.find(term => term.resource_id === source.result.settlement_key.resource_id);
  const cash = input.cash ?? null; const applied = input.applied ?? null;
  if (cash && (cash.agreement_id !== a.agreement_id || cash.payer_id !== a.payer_id || cash.currency !== a.currency)) throw new Error('The cash state belongs to another agreement, payer or currency.');
  if (applied && (applied.settlement_id !== settlementId || applied.payer_id !== input.payer_id)) throw new Error('The applied-source state belongs to another settlement or payer.');
  const appliedKey = `resource-usage-applied-source:${hash([a.agreement_id, a.payer_id, a.currency, settlementId])}`;
  if (allocation.kind === 'removed') {
    allocation.charged = zero;
    allocation.terms = applied?.terms ?? purchased;
  }
  if (!purchased || canonical(purchased) !== canonical(allocation.terms) || a.currency !== source.result.settlement_key.currency) throw new Error('The settlement does not retain this agreement\'s purchased resource tariff/currency.');
  const id = `resource-usage-provider-report:${hash([appliedKey, source.version])}`;
  const fingerprint = hash({ agreement_id: a.agreement_id, payer_id: input.payer_id, settlement_ref: source.version_ref, terms: purchased, provider_customer_id: a.provider_customer_id, provider_subscription_id: a.provider_subscription_id, provider_account_id: a.provider_account_id });
  let report = input.prior_report ?? null;
  if (report) {
    if (report.id !== id || report.input_identity !== fingerprint) throw new Error('This prior report belongs to another source version or frozen billing agreement; reconcile it instead of repricing it.');
    if (COMMITTED.includes(report.state) || report.state === 'reconciliation_required') return answerOf(report);
    assertCheckpoint(report, input);
  } else {
    if (cash && cash.currency_exponent !== a.currency_exponent) throw new Error('Do not change the precision of an existing cash ledger.');
    if (applied && applied.settlement_version >= source.version) throw new Error('This settlement version was already applied or superseded; keep the report that applied it.');
    const delta = subtractAmounts(allocation.charged, applied?.charged ?? zero);
    const plan = settlementCashPlan({ delta, carry: cash?.carry ?? zero, currency_exponent: a.currency_exponent, authorized_total: a.collection_authorized_total });
    report = { id, input_identity: fingerprint, state: 'prepared', settlement_id: settlementId, settlement_version: source.version, settlement_ref: source.version_ref,
      source_charged: allocation.charged, payer_id: input.payer_id, agreement: a, purchased_terms: purchased, exact_delta: delta, cash: plan, cash_before: cash, applied_before: applied,
      prepared_at: new Date(now).toISOString(), provider_idempotency_key: `usage-line:${hash(id)}`,
      provider_subject: { customer: a.provider_customer_id, subscription: a.provider_subscription_id, currency: a.currency, amount: plan.minor_units,
        description: a.usage_description ?? 'Measured usage', discountable: false, metadata: { usage_report_id: id, settlement_ref_hash: hash(source.version_ref) } } };
  }
  if (report.cash.minor_units === '0') return answerOf(finishReport(report));
  if (now - Date.parse(report.prepared_at) > RETRY_MS || now < Date.parse(report.prepared_at)) return answerOf({ ...report, state: 'reconciliation_required' });
  // Re-read authority on each dispatch attempt; a frozen request is not a fresh
  // spending grant. Preserve its amount/key but refuse a newly lowered ceiling.
  const magnitude = rational(report.cash.amount, 'cash amount', { signed: true });
  if (compareAmounts(exactAmount({ n: magnitude.n < 0n ? -magnitude.n : magnitude.n, d: magnitude.d }), a.collection_authorized_total) > 0) throw new Error('The frozen cash amount exceeds current collection authorization. Restore authority or reconcile any already dispatched report.');
  if (compareAmounts(addAmounts(report.cash_before?.net_reported ?? zero, report.cash.amount), zero) < 0) throw new Error('A credit would exceed the cash previously reported for this agreement.');
  const send = sender(context);
  await verifyBinding(send, a);
  if (context.assertCollectionAuthority) await context.assertCollectionAuthority({ agreement: a, report });
  const dispatching = { ...report, dispatch_started_at: new Date(now).toISOString() };
  let receipt;
  try {
    const provider = await call(send, 'operation:create-invoice-item', dispatching.provider_subject, { idempotencyKey: dispatching.provider_idempotency_key });
    receipt = receiptOf(provider, dispatching);
  } catch {
    // Keep the frozen body/key. A timeout or malformed answer is not evidence that
    // Stripe did nothing; never mint another key: pass this report back to retry.
    return { ...answerOf({ ...dispatching, state: 'outcome_unknown' }), next_action: 'Retry this same source version with this report as prior_report within the safe window, or reconcile the provider invoice-item receipt.' };
  }
  return answerOf(finishReport(dispatching, receipt));
}

export async function readResourceUsageReport(input, { door }) {
  const report = await door.read(usageReportingTypes.report, word(input.report_id, 'report_id'));
  return { report: report ? publicReport(report) : null };
}

/** After the safe POST window, read the actual provider object, never repeat the
 * charge. The provider object id may come from the existing invoice/history tool
 * or a provider support receipt; its exact metadata/customer/amount are checked.
 * `report` is the frozen report an earlier answer returned, `cash` and `applied`
 * the state that report was prepared from. */
export async function reconcileResourceUsageReport(input, context) {
  const report = input.report;
  if (!report || typeof report.id !== 'string' || !report.agreement) throw new Error('Give report, the frozen usage report an earlier answer returned.');
  if (COMMITTED.includes(report.state)) return answerOf(report);
  assertCheckpoint(report, input);
  const send = sender(context);
  const account = await call(send, 'operation:read-stripe-account');
  if (account?.id !== report.agreement.provider_account_id) throw new Error('The mounted payment account does not match this report.');
  const provider = await call(send, 'operation:read-invoice-item', null, { ref: word(input.provider_invoice_item_id, 'provider_invoice_item_id') });
  return answerOf(finishReport(report, receiptOf(provider, report)));
}

/** Only a known not-dispatched report may release its cash checkpoint. Unknown
 * dispatches retain their hold until the provider receipt is reconciled. */
export async function cancelPreparedResourceUsageReport(input, { door }) {
  const report = await door.read(usageReportingTypes.report, word(input.report_id, 'report_id'));
  if (!report) throw new Error('Read the prepared report before cancelling it.');
  if (report.state === 'cancelled_before_dispatch') return publicReport(report);
  if (report.state !== 'prepared' || report.dispatch_started_at) throw new Error('This report may have reached the payment provider; reconcile its receipt instead of cancelling a possible charge.');
  const cash = await door.read(usageReportingTypes.cash, report.cash_id);
  if (cash?.pending_report !== report.id) throw new Error('The cash checkpoint belongs to another report; read its current state.');
  const next = { ...report, state: 'cancelled_before_dispatch' };
  await door.write([
    { id: report.id, type: usageReportingTypes.report, value: next, expected: expected(usageReportingTypes.report, report) },
    { id: report.cash_id, type: usageReportingTypes.cash, value: { ...cash, version: cash.version + 1, pending_report: null }, expected: expected(usageReportingTypes.cash, cash) },
  ], { key: `${report.id}:cancel-before-dispatch` });
  return publicReport(next);
}
