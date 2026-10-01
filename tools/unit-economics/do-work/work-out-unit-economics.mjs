// tools/unit-economics/do-work/work-out-unit-economics.mjs
//
// The Workshop tool "Work out a business's unit economics". Reads one period's numbers as JSON (argv[2], the
// UnitEconomicsInput shape: whole cents and counts) and prints one JSON line: ARPU, gross margin, CAC, LTV, LTV:CAC,
// payback and lifetime, each null when these numbers cannot give it, plus the input echoed back.
import { computeUnitEconomics } from '../read-data/compute-unit-economics.ts';

const NUMBERS = ['net_revenue_cents', 'gross_revenue_cents', 'cost_of_delivery_cents', 'acquisition_spend_cents', 'active_customers', 'new_customers', 'avg_lifetime_periods', 'churn_rate'];
const REQUIRED = ['net_revenue_cents', 'gross_revenue_cents', 'active_customers'];

export function workOutUnitEconomics(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The input must be an object of the period\'s numbers.');
  const missing = REQUIRED.filter(field => typeof input[field] !== 'number');
  const wrong = NUMBERS.filter(field => input[field] !== undefined && !Number.isFinite(input[field]));
  if (missing.length || wrong.length) throw new Error(`${[...missing.map(field => `${field} is required`), ...wrong.map(field => `${field} must be a number`)].join('; ')}.`);
  return { ...computeUnitEconomics(Object.fromEntries(NUMBERS.filter(field => input[field] !== undefined).map(field => [field, input[field]]))), input };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(`${JSON.stringify(workOutUnitEconomics(JSON.parse(process.argv[2] ?? '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
