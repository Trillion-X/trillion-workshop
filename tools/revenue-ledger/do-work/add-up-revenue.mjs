// tools/revenue-ledger/do-work/add-up-revenue.mjs
//
// The Workshop tool "Add up revenue from a list of payments". Reads one JSON input (argv[2]):
//   { payments: [{ event_id, event_kind, occurred_at?, attributes: { ... } }],
//     how_to_read: { amount_field_path, recurring_field_path, currency_field_path?, event_role_map,
//                    active_predicate?, cohort_key_path? } }
// and prints one JSON line: the RevenueView (gross, refunds, net, active recurring, by cohort, by role, and the
// payments that need a look). Which fields hold what and which kinds add or subtract are the caller's DATA.
import { projectRevenue } from '../read-data/project-revenue.ts';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const path = value => Array.isArray(value) && value.length > 0 && value.every(part => typeof part === 'string');

export function addUpRevenue(input) {
  if (!object(input) || !Array.isArray(input.payments)) throw new Error('payments must be a list of payment events.');
  const reading = input.how_to_read;
  const problems = [];
  if (!object(reading)) problems.push('how_to_read must say where each payment keeps its amount and which kinds add or subtract');
  else {
    if (!path(reading.amount_field_path)) problems.push('how_to_read.amount_field_path must be a list of field names, like ["amount"]');
    if (reading.recurring_field_path !== undefined && !path(reading.recurring_field_path)) problems.push('how_to_read.recurring_field_path must be a list of field names');
    if (!object(reading.event_role_map)) problems.push('how_to_read.event_role_map must map each payment kind to "add", "subtract" or "ignore"');
  }
  input.payments.forEach((payment, index) => {
    if (!object(payment) || typeof payment.event_id !== 'string' || typeof payment.event_kind !== 'string' || !object(payment.attributes)) problems.push(`payments[${index}] needs event_id, event_kind and attributes`);
  });
  if (problems.length) throw new Error(`${problems.join('; ')}.`);
  const payments = input.payments.map(payment => ({ occurred_at: '', ...payment }));
  return { ...projectRevenue(payments, { currency_field_path: [], recurring_field_path: [], ...reading }), payments_read: payments.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(`${JSON.stringify(addUpRevenue(JSON.parse(process.argv[2] ?? '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
