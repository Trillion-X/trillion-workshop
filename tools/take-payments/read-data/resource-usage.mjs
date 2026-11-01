// Exact usage pricing is an extension of the existing offer/charge owner, not a
// supplier tariff or another payment rail. All prices and scopes are caller DATA.
// Money and units are rational {n,d} decimal strings. Never round a ledger share
// into a customer's cash bill; cashClearing is the separate quantization step.
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = (x, name) => { if (typeof x !== 'string' || !x.trim() || x.length > 512) throw new Error(`Give ${name} as nonempty text of at most 512 characters.`); return x; };
const gcd = (a, b) => { a = a < 0n ? -a : a; while (b) [a, b] = [b, a % b]; return a || 1n; };
function fraction(n, d = 1n) {
  if (d <= 0n) throw new Error('A rational denominator must be positive.');
  const g = gcd(n, d); n /= g; d /= g;
  if (n.toString().length > 512 || d.toString().length > 512) throw new Error('Exact amount precision exceeds the bounded settlement format; normalize the source units before pricing.');
  return { n, d };
}
const integer = (x, name) => { if (typeof x === 'number' && Number.isSafeInteger(x)) return BigInt(x); if (typeof x === 'string' && /^-?\d{1,100}$/.test(x)) return BigInt(x); throw new Error(`${name} must be a bounded integer decimal string.`); };
export function rational(value, name = 'amount', { signed = false } = {}) {
  let result;
  if (object(value)) result = fraction(integer(value.n, name), integer(value.d, `${name} denominator`));
  else if (typeof value === 'string' && /^-?\d{1,80}(?:\.\d{1,20})?$/.test(value)) {
    const sign = value.startsWith('-') ? -1n : 1n; const [whole, part = ''] = value.replace(/^-/, '').split('.');
    result = fraction(sign * BigInt(whole + part), 10n ** BigInt(part.length));
  } else result = fraction(integer(value, name));
  if (!signed && result.n < 0n) throw new Error(`${name} must not be negative.`);
  return result;
}
const zero = () => fraction(0n);
const add = (a, b) => fraction(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a, b) => fraction(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a, b) => fraction(a.n * b.n, a.d * b.d);
const div = (a, b) => { if (b.n <= 0n) throw new Error('Cannot divide by a nonpositive amount.'); return fraction(a.n * b.d, a.d * b.n); };
const cmp = (a, b) => a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0;
const min = (...xs) => xs.reduce((a, b) => cmp(a, b) <= 0 ? a : b);
const sum = xs => xs.reduce(add, zero());
export const exactAmount = value => ({ n: value.n.toString(), d: value.d.toString() });
export const compareAmounts = (a, b) => cmp(rational(a, 'left', { signed: true }), rational(b, 'right', { signed: true }));
export const addAmounts = (a, b) => exactAmount(add(rational(a, 'left', { signed: true }), rational(b, 'right', { signed: true })));
export const subtractAmounts = (a, b) => exactAmount(sub(rational(a, 'left', { signed: true }), rational(b, 'right', { signed: true })));
export const multiplyAmounts = (a, b) => exactAmount(mul(rational(a, 'left', { signed: true }), rational(b, 'right', { signed: true })));
export const divideAmounts = (a, b) => exactAmount(div(rational(a, 'left', { signed: true }), rational(b, 'right')));

/** Decimal text is for display only. The rational remains the billing authority. */
export function displayAmount(value, digits = 8) {
  if (!Number.isInteger(digits) || digits < 0 || digits > 12) throw new Error('Display digits must be from 0 to 12.');
  const a = rational(value, 'display amount', { signed: true }); const sign = a.n < 0n ? '-' : ''; const n = a.n < 0n ? -a.n : a.n;
  const scale = 10n ** BigInt(digits); const rounded = (n * scale * 2n + a.d) / (a.d * 2n);
  if (!digits) return sign + rounded;
  const raw = rounded.toString().padStart(digits + 1, '0'); const part = raw.slice(-digits).replace(/0+$/, '');
  return sign + raw.slice(0, -digits) + (part ? `.${part}` : '');
}
function bps(value) { const n = integer(value, 'markup_bps'); if (n < 0n || n > 1000000n) throw new Error('markup_bps must be between 0 and 1000000.'); return n; }
function timestamp(value, name) { text(value, name); if (!/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`Give ${name} as an ISO date/time.`); return Date.parse(value); }

export function validatePricingRule(raw) {
  if (!object(raw)) throw new Error('Give a usage pricing rule.');
  const scope = raw.scope ?? {}; if (!object(scope) || Object.keys(scope).some(k => !['resource_id', 'plan_id', 'client_id'].includes(k))) throw new Error('A pricing scope may name resource_id, plan_id and client_id only.');
  for (const [key, value] of Object.entries(scope)) text(value, key);
  timestamp(raw.effective_at, 'effective_at');
  let markup = raw.markup_bps === undefined ? null : bps(raw.markup_bps);
  if (raw.markup_percent !== undefined) {
    const percent = rational(String(raw.markup_percent), 'markup percent'); const points = mul(percent, fraction(100n));
    if (points.d !== 1n) throw new Error('Give markup percent with at most two decimal places.');
    const converted = bps(points.n.toString());
    if (markup !== null && converted !== markup) throw new Error('markup_percent and markup_bps disagree; give the intended percentage once.');
    markup = converted;
  }
  if (markup === null) throw new Error('Give markup_percent or markup_bps in the pricing rule.');
  return { ...raw, id: text(raw.id, 'rule id'), scope: { ...scope }, markup_bps: markup.toString(), markup_percent: displayAmount(exactAmount(fraction(markup, 100n)), 2) };
}

/** Client overrides plan overrides resource overrides default. Same-scope/same-time
 * ambiguity refuses rather than depending on record arrival order. A purchased
 * snapshot is not repriced from current mutable rules. */
export function resolveUsagePricing({ rules = [], resource_id, resource_path = [], plan_id, client_id, at, pinned_terms = null }) {
  const moment = timestamp(at, 'pricing time'); text(resource_id, 'resource_id');
  if (pinned_terms !== null) {
    if (!object(pinned_terms) || pinned_terms.resource_id !== resource_id || !pinned_terms.rule_ref) throw new Error('Pinned terms must identify this resource and their original rule_ref.');
    if (pinned_terms.effective_at && timestamp(pinned_terms.effective_at, 'pinned effective_at') > moment) throw new Error('Pinned pricing terms are not effective yet.');
    return { ...pinned_terms, markup_bps: bps(pinned_terms.markup_bps).toString(), pinned: true };
  }
  if (!Array.isArray(rules) || rules.length > 10000 || !Array.isArray(resource_path) || resource_path.length > 64) throw new Error('Use at most 10000 rules and a resource path of at most 64 items.');
  const path = [...new Set([...resource_path, resource_id])];
  const versions = new Map();
  for (const rule of rules.map(validatePricingRule)) {
    if (Date.parse(rule.effective_at) > moment) continue;
    const prior = versions.get(rule.id);
    if (prior && Date.parse(prior.effective_at) === Date.parse(rule.effective_at) && (prior.version ?? 0) === (rule.version ?? 0)) throw new Error('A pricing rule revision appears twice; provide one immutable version.');
    if (!prior || Date.parse(rule.effective_at) > Date.parse(prior.effective_at) || (Date.parse(rule.effective_at) === Date.parse(prior.effective_at) && (rule.version ?? 0) > (prior.version ?? 0))) versions.set(rule.id, rule);
  }
  const matched = [...versions.values()].filter(rule => {
    const s = rule.scope;
    return (rule.state ?? 'active') === 'active' && Date.parse(rule.effective_at) <= moment
      && (!rule.ends_at || timestamp(rule.ends_at, 'ends_at') > moment)
      && (!s.resource_id || path.includes(s.resource_id)) && (!s.plan_id || s.plan_id === plan_id) && (!s.client_id || s.client_id === client_id);
  }).map(rule => ({ rule, score: [rule.scope.client_id ? 1 : 0, rule.scope.plan_id ? 1 : 0, rule.scope.resource_id ? path.indexOf(rule.scope.resource_id) + 1 : 0, Date.parse(rule.effective_at)] }));
  matched.sort((a, b) => { for (let i = 0; i < a.score.length; i++) if (a.score[i] !== b.score[i]) return b.score[i] - a.score[i]; return 0; });
  if (!matched.length) throw new Error(`No effective usage pricing rule covers ${resource_id}; do not invent a price.`);
  if (matched[1] && matched[0].score.every((v, i) => v === matched[1].score[i])) throw new Error('Two equally specific pricing rules are effective together; supersede one explicitly.');
  const rule = matched[0].rule;
  return { resource_id, markup_bps: rule.markup_bps, rule_ref: rule.version_ref ?? rule.id, effective_at: rule.effective_at, pinned: false };
}

function multiplier(terms) { return fraction(10000n + bps(terms.markup_bps), 10000n); }
/** Quote the two distinct liabilities before a bounded physical attempt. This
 * is deliberately not a reservation: the existing atomic budget/lease owner
 * must admit both liabilities against verified remaining balances and the
 * purchased entitlement before the byte owner dispatches work. */
export function resourceReservationQuote({ requested_units, remaining_included_units = '0', max_unit_cost, terms, customer_available, company_available = '0' }) {
  if (!terms?.rule_ref || !terms.resource_id) throw new Error('A reservation quote needs the purchased terms and their rule_ref.');
  const requested = rational(requested_units, 'requested source units');
  const included = min(requested, rational(remaining_included_units, 'remaining included units'));
  const excess = sub(requested, included); const rate = rational(max_unit_cost, 'maximum supplier unit cost');
  const company = mul(included, rate); const customer = mul(mul(excess, rate), multiplier(terms));
  const companyAvailable = rational(company_available, 'verified company available'); const customerAvailable = rational(customer_available, 'verified customer available');
  return { state: cmp(company, companyAvailable) > 0 ? 'funding_required' : cmp(customer, customerAvailable) > 0 ? 'customer_budget_exceeded' : 'quote_within_supplied_balances',
    requested_units: exactAmount(requested), included_units: exactAmount(included), excess_units: exactAmount(excess), company_liability: exactAmount(company), customer_liability: exactAmount(customer),
    terms: structuredClone(terms), requires_atomic_reservation: true };
}
export function settlementKey(value) {
  if (!object(value)) throw new Error('Give the complete supplier settlement_key.');
  const fields = ['supplier_pool', 'tariff_version', 'cost_class', 'invoice_period', 'currency', 'resource_id'];
  return Object.fromEntries(fields.map(field => [field, text(value[field], `settlement_key.${field}`)]));
}
const keyText = key => JSON.stringify(settlementKey(key));

/** Allocate verified supplier cost only inside one settlement scope. Excess units
 * are already consumed/classified once by the customer entitlement owner; this
 * function never clones an allowance into several supplier pools. Company cost
 * is explicit. A residual without explicit funding remains funding_required. */
export function settleResourcePool({ settlement_key, invoice, payers, company_funding = '0' }) {
  const key = settlementKey(settlement_key);
  if (!object(invoice) || invoice.status !== 'confirmed' || !invoice.evidence_ref) throw new Error('Reconcile a confirmed supplier invoice with its evidence_ref before pricing final usage.');
  const cost = rational(invoice.amount, 'supplier invoice');
  if (!Array.isArray(payers) || payers.length > 10000) throw new Error('Give at most 10000 attributed payers for this settlement.');
  const seen = new Set();
  const rows = payers.map(p => {
    text(p.payer_id, 'payer_id'); if (seen.has(p.payer_id)) throw new Error('A payer appears twice in one settlement.'); seen.add(p.payer_id);
    if (!['customer', 'platform'].includes(p.kind)) throw new Error('A payer kind is customer or platform.');
    if (p.settlement_key && keyText(p.settlement_key) !== keyText(key)) throw new Error('A payer observation belongs to another supplier settlement key.');
    const excess = rational(p.excess_units, 'excess units');
    if (p.kind === 'platform') return { p, excess };
    if (!object(p.terms) || !p.terms.rule_ref || p.terms.resource_id !== key.resource_id) throw new Error('Each customer needs the purchased resource terms and rule_ref.');
    return { p, excess, multiple: multiplier(p.terms), ceiling: rational(p.max_unit_cost, 'maximum supplier unit cost'), authorized: rational(p.authorized_total, 'authorized customer total') };
  });
  const totalExcess = sum(rows.map(row => row.excess)); let platform = zero(); let residual = zero();
  const allocations = rows.map(({ p, excess, multiple, ceiling, authorized }) => {
    const proposed = totalExcess.n === 0n ? zero() : mul(cost, div(excess, totalExcess));
    let base; let markup = zero(); let charged = zero();
    if (p.kind === 'platform') { base = proposed; platform = add(platform, base); }
    else {
      base = min(proposed, mul(excess, ceiling), div(authorized, multiple));
      charged = mul(base, multiple); markup = sub(charged, base); residual = add(residual, sub(proposed, base));
    }
    return { payer_id: p.payer_id, kind: p.kind, excess_units: exactAmount(excess), provisional_cost: exactAmount(proposed), supplier_cost: exactAmount(base), markup_amount: exactAmount(markup), charged: exactAmount(charged),
      ...(p.kind === 'customer' ? { terms: structuredClone(p.terms), limits: { max_unit_cost: exactAmount(ceiling), authorized_total: exactAmount(authorized) } } : {}),
      display: { base_cost: displayAmount(exactAmount(base)), markup: displayAmount(exactAmount(markup)), total: displayAmount(exactAmount(charged)), markup_percent: p.kind === 'customer' ? displayAmount(exactAmount(fraction(bps(p.terms.markup_bps), 100n))) : null } };
  });
  if (totalExcess.n === 0n) residual = cost;
  const companyCost = add(platform, residual); const funding = rational(company_funding, 'company funding');
  const customerCost = sum(allocations.filter(p => p.kind === 'customer').map(p => rational(p.supplier_cost)));
  if (cmp(add(customerCost, companyCost), cost) !== 0) throw new Error('Settlement did not conserve the supplier invoice.');
  return { settlement_key: key, state: cmp(companyCost, funding) > 0 ? 'funding_required' : 'reconciled', invoice: { status: 'confirmed', amount: exactAmount(cost), evidence_ref: invoice.evidence_ref }, allocations,
    customer_supplier_cost: exactAmount(customerCost), platform_supplier_cost: exactAmount(platform), company_residual: exactAmount(residual), company_cost: exactAmount(companyCost), company_funding: exactAmount(funding),
    customer_charged: exactAmount(sum(allocations.map(p => rational(p.charged)))), cash_state: 'exact_accrual_not_cash_collection' };
}

/** Whole cash quanta only; a subcent remainder is carried, never redistributed
 * onto another payer. The ceiling includes any authorized prior carry. */
export function cashClearing({ amount, carry = '0', quantum = '0.01', ceiling = null }) {
  const total = add(rational(amount), rational(carry)); const unit = rational(quantum, 'cash quantum');
  if (unit.n === 0n) throw new Error('Cash quantum must be positive.');
  const available = ceiling === null ? total : min(total, rational(ceiling, 'cash ceiling'));
  const count = div(available, unit); const cash = mul(unit, fraction(count.n / count.d));
  return { amount: exactAmount(cash), carry: exactAmount(sub(total, cash)), total_accrued: exactAmount(total) };
}

/** Rollups never carry an independent cost or markup. Presentation hides detail,
 * not liability. Every leaf keeps the rule/version and exact priced components. */
export function priceUsageTree({ tree, rules = [], at, plan_id, client_id, pinned_terms = {} }) {
  const seen = new Set(); let count = 0;
  const visit = (node, path, depth) => {
    if (!object(node) || depth > 32 || ++count > 10000) throw new Error('A usage tree must be a tree of at most 10000 nodes and 32 layers.');
    text(node.id, 'usage node id'); if (seen.has(node.id)) throw new Error('A usage node id appears twice.'); seen.add(node.id);
    if (node.charged !== undefined || node.markup_amount !== undefined) throw new Error('Price measured base costs, not a tree that already contains priced charges.');
    const children = node.children ?? []; if (!Array.isArray(children)) throw new Error('Usage children must be an array.');
    const resourcePath = node.resource_id ? [...path, node.resource_id] : path;
    let base, markup, charged, terms = null;
    const priced = children.map(child => visit(child, resourcePath, depth + 1));
    if (priced.length) {
      if (node.cost !== undefined || node.markup_bps !== undefined) throw new Error('A rollup cannot add its own cost or markup; represent direct work as a separate leaf.');
      base = sum(priced.map(p => rational(p.base_cost))); markup = sum(priced.map(p => rational(p.markup_amount))); charged = sum(priced.map(p => rational(p.charged)));
    } else {
      base = rational(node.cost, 'leaf measured cost');
      terms = resolveUsagePricing({ rules, resource_id: node.resource_id, resource_path: resourcePath, plan_id, client_id, at, pinned_terms: pinned_terms[node.id] ?? pinned_terms[node.resource_id] ?? null });
      charged = mul(base, multiplier(terms)); markup = sub(charged, base);
    }
    return { id: node.id, label: text(node.label, 'usage label'), currency: text(node.currency, 'currency'), state: node.state ?? 'reconciled',
      ...(node.resource_id ? { resource_id: node.resource_id } : {}), ...(node.quantity !== undefined ? { quantity: node.quantity, unit: node.unit ?? null } : {}),
      base_cost: exactAmount(base), markup_amount: exactAmount(markup), charged: exactAmount(charged), markup_bps: terms?.markup_bps ?? null, ...(terms ? { pricing_rule_ref: terms.rule_ref, terms } : {}),
      presentation: { visible: node.presentation?.visible !== false, expanded: node.presentation?.expanded === true }, children: priced,
      display: { base_cost: displayAmount(exactAmount(base)), markup: displayAmount(exactAmount(markup)), total: displayAmount(exactAmount(charged)), markup_percent: terms ? displayAmount(exactAmount(fraction(bps(terms.markup_bps), 100n))) : null } };
  };
  const result = visit(tree, [], 0);
  const checkCurrency = node => { if (node.currency !== result.currency) throw new Error('Do not roll different currencies into one usage total.'); node.children.forEach(checkCurrency); };
  checkCurrency(result); return result;
}
