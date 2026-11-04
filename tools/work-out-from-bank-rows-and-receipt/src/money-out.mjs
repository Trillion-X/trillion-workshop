// src/money-out.mjs
//
// Purpose: turn the outgoing payments a person's bank feeds and receipt emails show into one row per merchant they pay:
// what it costs them a month, how it is billed, when it renews, whether it is going up, and whether it may be paid twice.
// Rules and words are in src/money-out.json; nothing here names a merchant or a service.
//
// Shapes
//   merchantsFrom({ sources, connectors?, now?, data? }) -> { merchants, total: { month, days_90 }, sources }
//     connectors is the payments answer's descriptors (vendor, name, domain). Payments go back lookback_days, so a yearly
//     bill's cycle is seen; the cost, trend, charges and duplicates use only window_days.
//   merchantKey(raw, { data? }) -> string                  the bare name a merchant string is known by
//   connectorFor(key, connectors?, { data? }) -> entry|null  the catalog entry a merchant is, if any
//   cycleOf(gapDays, { data? }) -> 'monthly' | 'yearly' | 'weekly' | null

import defaults from '../../money-out/src/money-out.json' with { type: 'json' };

const DAY_MS = 86_400_000;
const sum = numbers => numbers.reduce((total, number) => total + number, 0);
const round2 = dollars => Math.round(dollars * 100) / 100;
const median = numbers => {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
const inRange = (value, [low, high]) => value >= low && value <= high;

/** The name a merchant string is known by: lower case, with the payment processor, any reference after `*`, company
 *  suffixes and trailing number, state or zip noise taken off. "SQ *BLUE BOTTLE" -> "blue bottle". */
export function merchantKey(raw, { data = defaults } = {}) {
  const original = String(raw ?? '').trim().replace(/\s+/g, ' ');
  let text = original;
  const prefix = text.match(/^([a-z]+)\s*\*\s*/i);
  if (prefix && data.processor_prefixes.includes(prefix[1].toLowerCase())) text = text.slice(prefix[0].length);
  if (text.includes('*')) text = text.slice(0, text.indexOf('*'));
  const words = text.replace(/[^A-Za-z0-9#]+/g, ' ').trim().split(' ').filter(Boolean);
  const suffixes = new Set(data.suffixes);
  // Trailing noise comes off one word at a time, never the name's first word.
  const noise = word => /^#?\d+$/.test(word) || suffixes.has(word.toLowerCase()) || /^[A-Z]{2}$/.test(word);
  while (words.length > 1 && noise(words.at(-1))) words.pop();
  return words.join(' ').toLowerCase() || original.replace(/[^A-Za-z0-9]+/g, ' ').trim().toLowerCase();
}

/** The catalog entry a merchant key is: its name is the key or starts it, or its domain's first word is a whole word in it. */
const byName = (key, connector, data) => { const name = merchantKey(connector.name, { data }); return Boolean(name) && (key === name || key.startsWith(`${name} `)); };
export function connectorFor(key, connectors = [], { data = defaults } = {}) {
  for (const connector of connectors) {
    const name = merchantKey(connector.name, { data });
    const label = String(connector.domain ?? '').split('.')[0].toLowerCase();
    if (name && (key === name || key.startsWith(`${name} `))) return connector;
    if (label.length >= data.min_label_length && ` ${key} `.includes(` ${label} `)) return connector;
  }
  return null;
}

/** How often a merchant is paid, from the median days between its charges: monthly, yearly, weekly, or null. */
export function cycleOf(gapDays, { data = defaults } = {}) {
  const days = Math.round(gapDays);
  return Object.keys(data.cycles).find(name => inRange(days, data.cycles[name])) ?? null;
}

// The cleanest raw name a merchant was seen under (the shortest), title-cased when it was all capitals.
const titleOf = raws => {
  const text = [...raws].sort((a, b) => a.length - b.length)[0].trim().replace(/\s+/g, ' ');
  return text === text.toUpperCase() ? text.toLowerCase().replace(/\b[a-z]/g, letter => letter.toUpperCase()) : text;
};

// One merchant row from the kept payments that share a key. The cycle reads every payment in the lookback; everything
// shown (cost, trend, charges, duplicates) reads the window. A merchant with no charge in the window is left out, unless
// it is yearly: an annual plan is still paid, so it stays with its cost a month.
function merchantOf(key, rows, { connectors, now, data }) {
  const oldestFirst = [...rows].sort((a, b) => a.at - b.at);
  const newestFirst = [...oldestFirst].reverse();
  const newest = oldestFirst.at(-1);
  const connector = connectorFor(key, connectors, { data });
  const gaps = oldestFirst.slice(1).map((payment, index) => (payment.at - oldestFirst[index].at) / DAY_MS);
  const cycle = gaps.length ? cycleOf(median(gaps), { data }) : null;
  const windowSince = now - data.window_days * DAY_MS;
  const inWindow = oldestFirst.filter(payment => payment.at > windowSince);
  if (!inWindow.length && cycle !== 'yearly') return null;
  const amounts = inWindow.map(payment => payment.amount);
  const days_90 = round2(sum(amounts));
  // What it costs per month: a monthly bill as paid, a yearly one spread over twelve, a weekly one as a month.
  const month = round2(cycle === 'monthly' ? median(amounts)
    : cycle === 'yearly' ? newest.amount / 12
      : cycle === 'weekly' ? (median(amounts) * 52) / 12
        : sum(amounts) / 3);
  const span = data.trend.window_days * DAY_MS;
  const paidBetween = (from, to) => round2(sum(inWindow.filter(payment => payment.at > from && payment.at <= to).map(payment => payment.amount)));
  const last_30 = paidBetween(now - span, now);
  const prior_30 = paidBetween(now - 2 * span, now - span);
  // New when its first charge is within the last window; otherwise the change against the window before it.
  const isNew = oldestFirst[0].at > now - span;
  const percent = isNew || prior_30 === 0 ? null : Math.round(((last_30 - prior_30) / prior_30) * 100);
  const change = isNew ? 'new'
    : percent === null ? (last_30 > 0 ? 'up' : 'flat')
      : Math.abs(percent) <= data.trend.flat_percent ? 'flat' : percent > 0 ? 'up' : 'down';
  // A monthly merchant charged twice in a few days for about the same amount, from different accounts or sources.
  const twice = inWindow.some((a, index) => inWindow.slice(index + 1).some(b => b.at - a.at <= data.duplicate_days * DAY_MS
    && Math.abs(a.amount - b.amount) <= (Math.max(a.amount, b.amount) * data.duplicate_percent) / 100
    && a.account !== b.account));
  const flags = cycle === 'monthly' && twice ? [data.flag_duplicate] : [];
  return {
    key,
    // A payee takes a connection's name only when it is that name; matched by web address alone (google -> Gmail's
    // google.com) it keeps its own, and only borrows the connection's logo and readers.
    title: connector && byName(key, connector, data) ? connector.name : titleOf(rows.map(payment => payment.merchant)),
    logo: connector?.logo ?? null,
    vendor: connector?.vendor ?? null,
    group: newest.source.group,
    plan: newestFirst.find(payment => payment.plan)?.plan ?? null,
    month, days_90, cycle,
    last_at: newest.at_raw,
    last_amount: newest.amount,
    renews_at: cycle ? dayOf(newest.at + median(gaps) * DAY_MS) : null,
    trend: { last_30, prior_30, change, percent },
    flags,
    charges: [...inWindow].reverse().map(payment => ({ id: payment.id, at: payment.at_raw, amount: payment.amount, source: payment.source.id, ...(payment.plan ? { plan: payment.plan } : {}) })),
    sources: [...new Set(newestFirst.map(payment => payment.source.id))],
  };
}

/** Outgoing payments from a person's sources (bank feeds and receipt emails), one row per merchant they pay, biggest
 *  monthly cost first, with the totals. A payment counts once even when a bank feed and a receipt both show it. */
export function merchantsFrom({ sources = [], connectors = [], now = Date.now(), data = defaults } = {}) {
  const since = now - data.lookback_days * DAY_MS;
  const windowSince = now - data.window_days * DAY_MS;
  const payments = [];
  for (const { source, payments: rows = [] } of sources) {
    for (const payment of rows) {
      const at = Date.parse(payment.at);
      if (!Number.isFinite(at) || at < since || at > now) continue;
      payments.push({ ...payment, at, at_raw: payment.at, source, account: payment.account ?? source.id, key: merchantKey(payment.merchant, { data }) });
    }
  }
  // The same payment in a bank feed and a receipt email (same merchant, close amount and date): the bank's row stays and takes the receipt's plan.
  const dropped = new Set();
  const close = (bank, mail) => Math.abs(bank.amount - mail.amount) * 100 <= data.same_payment.cents && Math.abs(bank.at - mail.at) <= data.same_payment.days * DAY_MS;
  for (const mail of payments.filter(payment => payment.source.kind === 'mail')) {
    const bank = payments.find(payment => payment.source.kind === 'bank' && payment.key === mail.key && close(payment, mail));
    if (!bank) continue;
    dropped.add(mail);
    if (!bank.plan && mail.plan) bank.plan = mail.plan;
  }
  const kept = payments.filter(payment => !dropped.has(payment));
  const groups = new Map();
  for (const payment of kept) groups.set(payment.key, [...(groups.get(payment.key) ?? []), payment]);
  const merchants = [...groups].map(([key, rows]) => merchantOf(key, rows, { connectors, now, data })).filter(Boolean);
  // Two different merchants that map to the same vendor are flagged together.
  const vendors = new Map();
  for (const merchant of merchants) if (merchant.vendor) vendors.set(merchant.vendor, (vendors.get(merchant.vendor) ?? 0) + 1);
  for (const merchant of merchants) {
    if (merchant.vendor && vendors.get(merchant.vendor) > 1 && !merchant.flags.includes(data.flag_duplicate)) merchant.flags.push(data.flag_duplicate);
  }
  merchants.sort((a, b) => b.month - a.month || a.title.localeCompare(b.title));
  const windowed = kept.filter(payment => payment.at > windowSince);
  const total = { month: round2(sum(merchants.map(merchant => merchant.month))), days_90: round2(sum(windowed.map(payment => payment.amount))) };
  const sourceRows = sources.map(({ source }) => {
    const mine = windowed.filter(payment => payment.source.id === source.id);
    return { id: source.id, label: source.label, group: source.group, kind: source.kind, count: mine.length, days_90: round2(sum(mine.map(payment => payment.amount))) };
  });
  return { merchants, total, sources: sourceRows };
}

export { defaults };
