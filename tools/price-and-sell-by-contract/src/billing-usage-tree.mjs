// Billing's projection of already purchased, already counted usage. Pricing and
// exact money operations remain in take-payments; this adapter does not reprice
// a purchased day from today's mutable rules and never observes private files.
import { addAmounts, subtractAmounts, multiplyAmounts, divideAmounts, displayAmount, compareAmounts } from '../../take-payments/read-data/resource-usage.mjs';
import { offerUsage, usageRow, unitsAbove } from './usage-meters.mjs';
import settings from './billing-screen.json' with { type: 'json' };

const ZERO = Object.freeze({ n: '0', d: '1' });
const decimal = (value, field) => {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`The purchased ${field} is unavailable.`);
  // Expand the purchased Number's decimal spelling, without rounding small
  // positive rates down to zero at an arbitrary fixed precision.
  const [coefficient, exponent] = String(value).toLowerCase().split('e');
  if (exponent === undefined) return coefficient;
  const [whole, fraction = ''] = coefficient.split('.');
  const digits = whole + fraction, point = whole.length + Number(exponent);
  return point <= 0 ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length ? digits + '0'.repeat(point - digits.length)
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
};
const total = (rows, field) => rows.reduce((sum, row) => addAmounts(sum, row[field]), ZERO);
const WORDS = settings.usage_breakdown;

/** Validate the entire counted statement, including hidden details. Display
 * strings are never used to compute a charge. */
function checkedTree(tree, currency) {
  const ids = new Set(); let count = 0;
  const visit = (row, depth) => {
    if (!row || typeof row.id !== 'string' || !row.id || !Array.isArray(row.children)) throw new TypeError('A usage detail needs its identity and children.');
    if (depth > 32 || ++count > 10000 || ids.has(row.id)) throw new RangeError('Usage details repeat or exceed the bounded statement.');
    ids.add(row.id);
    if (row.currency !== currency) throw new TypeError('Do not combine different currencies in one usage total.');
    row.children.forEach(child => visit(child, depth + 1));
    if (row.charged != null) {
      if (compareAmounts(addAmounts(row.base_cost, row.markup_amount), row.charged) !== 0) throw new TypeError('Usage cost components do not match its charge.');
      if (row.children.length && (row.children.some(child => child.charged == null) || compareAmounts(total(row.children, 'charged'), row.charged) !== 0)) throw new TypeError('Usage details do not match their total.');
    }
  };
  visit(tree, 0);
  return tree;
}

/** Sum exact, already priced children. A parent carries no independent price,
 * so opening, hiding or moving detail cannot charge it a second time. */
export function usageRollup(id, label, children, currency = 'usd') {
  if (!Array.isArray(children) || children.length > 10000) throw new RangeError('Read a bounded page of usage details.');
  if (children.some(row => row.currency !== currency)) throw new TypeError('Do not combine different currencies in one usage total.');
  const pending = children.some(row => row.charged == null || !['reconciled', 'purchased_terms'].includes(row.state));
  const known = children.filter(row => row.charged != null);
  const base = total(known, 'base_cost'), markup = total(known, 'markup_amount'), charged = total(known, 'charged');
  return { id, label, currency, state: pending ? 'pending' : 'reconciled', children,
    base_cost: pending ? null : base, markup_amount: pending ? null : markup, charged: pending ? null : charged,
    known_subtotal: charged, presentation: { visible: true, expanded: false },
    display: { base_cost: pending ? null : displayAmount(base), markup: pending ? null : displayAmount(markup), total: pending ? null : displayAmount(charged), markup_percent: null } };
}

function countedDay(purchase, term, entry) {
  const amount = entry.readings?.[term.meter.reading];
  if (!Number.isSafeInteger(amount) || amount < 0) throw new TypeError('Counted usage has no valid measured amount.');
  const units = unitsAbove(amount, term);
  if (!Number.isSafeInteger(units)) throw new TypeError('Counted usage exceeds the purchased meter bounds.');
  const days = decimal(term.meter.days_per, 'price period');
  if (Number(days) <= 0) throw new TypeError('A purchased price needs its positive period.');
  const charged = term.pricing_terms
    ? divideAmounts(multiplyAmounts(String(units), term.unit_amount_decimal), '100')
    : divideAmounts(multiplyAmounts(String(units), decimal(term.cents_per_unit, 'unit price')), multiplyAmounts('100', days));
  const base = divideAmounts(multiplyAmounts(String(units), decimal(term.cost_dollars, 'base rate')), days);
  if (compareAmounts(charged, base) < 0) throw new TypeError('The purchased usage price is below its recorded base rate.');
  const markup = subtractAmounts(charged, base);
  const nominalPercent = displayAmount(multiplyAmounts(subtractAmounts(decimal(term.meter.cost.margin, 'markup'), '1'), '100'));
  return { id: `usage:${purchase.id}:${term.meter.id}:${entry.day}`, label: entry.day,
    resource_id: term.meter.id, currency: term.currency ?? 'usd', state: 'purchased_terms',
    quantity: { n: String(amount), d: String(term.meter.per_unit) }, unit: term.meter.unit,
    base_cost: base, markup_amount: markup, charged, children: [],
    pricing_rule_ref: term.pricing_terms?.rule_ref ?? term.price_option_id,
    presentation: { visible: true, expanded: false },
    // Old prices can include unit-price rounding. Preserve their exact charge
    // and show their effective percentage instead of falsely calling it 30%.
    display: { base_cost: displayAmount(base), markup: displayAmount(markup), total: displayAmount(charged),
      markup_percent: compareAmounts(base, ZERO) === 0 ? String(nominalPercent) : displayAmount(multiplyAmounts(divideAmounts(markup, base), '100'), 4) } };
}

/** Same purchased rows/history Billing already reads, with optional additional
 * confirmed settlement trees. Additional rows must name the meters they replace;
 * a partial new statement cannot silently hide existing storage/work charges. */
export function billingUsageTree({ purchases = [], own_work = [], offer = null, additional = null } = {}) {
  if (additional?.composition === 'complete') return checkedTree(additional.tree, additional.tree?.currency);
  if (additional?.replaces_meter_ids !== undefined && (!Array.isArray(additional.replaces_meter_ids) || additional.replaces_meter_ids.some(id => typeof id !== 'string'))) throw new TypeError('Replacement meters must be named explicitly.');
  const replaced = new Set(additional?.replaces_meter_ids ?? []);
  const groups = [];
  const source = purchases.length ? purchases : own_work.length && offer ? [{ id: 'own', label: WORDS.own_usage, terms: offerUsage(offer), history: own_work }] : [];
  for (const purchase of source) {
    const resources = [];
    for (const raw of purchase.terms ?? []) {
      const term = usageRow(raw);
      if (replaced.has(term.meter.id)) continue;
      const days = (purchase.history ?? []).filter(entry => entry.readings?.[term.meter.reading] !== undefined).map(entry => countedDay(purchase, term, entry));
      if (days.length) resources.push(usageRollup(`usage:${purchase.id}:${term.meter.id}`, term.meter.label, days, term.currency ?? 'usd'));
    }
    if (resources.length) groups.push(usageRollup(`usage:${purchase.id}`, purchase.label || WORDS.purchased_usage, resources, resources[0].currency));
  }
  if (additional) {
    const tree = additional.tree ?? additional;
    if (!tree.id || !tree.currency || !Array.isArray(tree.children)) throw new TypeError('The current usage settlement tree could not be read.');
    groups.push(tree);
  }
  return groups.length ? checkedTree(usageRollup('billing-usage', WORDS.total_label, groups, groups[0].currency), groups[0].currency) : null;
}
