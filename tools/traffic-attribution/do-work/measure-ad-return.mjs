// tools/traffic-attribution/do-work/measure-ad-return.mjs
//
// The Workshop tool "Measure what ad spend brings back". argv[2] is one JSON input:
//   { project: { id, label?, outcomes?, currency? }, visits: [{ visitor, signals }], conversions?: [{ visitor, outcome?, value? }],
//     paying_outcome, signup_outcome?, break_down_by?, spend?: [{ amount, currency?, <signal>: value }],
//     spend_answers?: [{ shape, answer, facts? }], revenue_months?, gross_margin?, monthly_churn?,
//     customer_lifetime_months?, target_ltv_to_cac? }
// Visitors count once by first touch (groupObserverFactsByProject, the same fold the breakdown uses). Spend joins the
// visitors whose first-touch signal `break_down_by` (default source) has the value the spend row carries for it; a
// spend row read from an ad platform's answer is shaped by ad-return.json `spend_shapes`. For each value and for
// everything together it gives spend, visitors, sign-ups, paying customers, their revenue, cost per sign-up, and the
// unit economics computeUnitEconomics works out (tools/unit-economics, the one place those formulas live): CAC,
// revenue per customer per month, LTV, LTV:CAC and payback months, with whether LTV:CAC meets the target. `paid` is
// the values that carry spend taken together (what the spend bought); `total` is every visitor against all spend
// (blended, organic customers included). A figure
// these numbers cannot give is null, and `unknown` says what would give it.
import settings from '../read-data/ad-return.json' with { type: 'json' };
import { buildTrackedProjectRecord } from '../read-data/registry.ts';
import { isClickIdSignal } from '../read-data/click-ids.ts';
import { groupObserverFactsByProject, TRAFFIC_CONVERSION_KIND, TRAFFIC_OBSERVER_FACT_KIND } from './observe-traffic.ts';
import { computeUnitEconomics } from '../../unit-economics/read-data/compute-unit-economics.ts';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '');
const amountOf = value => (typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN);
const NOT_TAGGED = '(not tagged)';
const SPEND_ROW_KEYS = new Set(['amount', 'currency']);

/** The values at a path, where '*' takes every item of a list. */
function at(value, path) {
  let found = [value];
  for (const step of path) {
    found = found.flatMap(item => (step === '*' ? (Array.isArray(item) ? item : []) : object(item) && Object.hasOwn(item, step) ? [item[step]] : []));
  }
  return found;
}

/** Spend rows `{ amount, currency, facts }` from the entered rows and from each ad platform answer, by its shape. */
function spendRows(input) {
  const rows = [];
  const from = [];
  const entered = Array.isArray(input.spend) ? input.spend : [];
  entered.forEach((row, index) => {
    const amount = amountOf(row?.amount);
    if (!object(row) || !Number.isFinite(amount) || amount < 0) throw new Error(`spend[${index}].amount must be a number of currency units, 0 or more.`);
    rows.push({ amount, currency: text(row.currency), facts: Object.fromEntries(Object.entries(row).filter(([key]) => !SPEND_ROW_KEYS.has(key)).map(([key, value]) => [key, text(value)])) });
  });
  if (entered.length) from.push({ from: 'entered', rows: entered.length, amount: entered.reduce((sum, row) => sum + amountOf(row.amount), 0) });
  (Array.isArray(input.spend_answers) ? input.spend_answers : []).forEach((given, index) => {
    const shape = settings.spend_shapes[given?.shape];
    if (!shape) throw new Error(`spend_answers[${index}].shape must be one of ${Object.keys(settings.spend_shapes).join(', ')}.`);
    const extra = object(given.facts) ? Object.fromEntries(Object.entries(given.facts).map(([key, value]) => [key, text(value)])) : {};
    let total = 0;
    const read = at(given.answer, shape.rows);
    read.forEach((row, place) => {
      const amount = (at(row, shape.amount).map(amountOf)[0] ?? NaN) * shape.amount_scale;
      if (!Number.isFinite(amount) || amount < 0) throw new Error(`spend_answers[${index}] row ${place} has no spend at ${shape.amount.join('.')}.`);
      const facts = { ...extra };
      for (const [signal, path] of Object.entries(shape.facts)) {
        const value = text(at(row, path)[0]);
        if (value) facts[signal] = value;
      }
      rows.push({ amount, currency: text(at(row, shape.currency)[0]), facts });
      total += amount;
    });
    from.push({ from: shape.label, rows: read.length, amount: Math.round(total * 100) / 100 });
  });
  return { rows, from };
}

/** Visitors, sign-ups, paying customers and their revenue among first-touch rows. */
function tally(rows, signup, paying) {
  const did = (row, outcome) => Boolean(outcome) && (row.outcomes ?? []).includes(outcome);
  return {
    visitors: rows.length,
    signups: signup ? rows.filter(row => did(row, signup)).length : null,
    customers: rows.filter(row => did(row, paying)).length,
    revenue: rows.reduce((sum, row) => sum + (did(row, paying) && typeof row.value === 'number' ? row.value : 0), 0),
  };
}

const cents = units => Math.round(units * 100);
const units = value => (value === null ? null : Math.round(value) / 100);
const rounded = (value, places) => (value === null ? null : Math.round(value * 10 ** places) / 10 ** places);

export function measureAdReturn(input) {
  if (!object(input) || !object(input.project)) throw new Error('project must say which project the visits belong to ({ id }).');
  const project = buildTrackedProjectRecord({ projectId: input.project.id, label: input.project.label, conversionMetrics: input.project.outcomes, currency: input.project.currency });
  if (!project) throw new Error('project.id must be letters, numbers, dots, dashes or underscores.');
  if (!Array.isArray(input.visits)) throw new Error('visits must be a list of { visitor, signals }.');
  const paying = text(input.paying_outcome);
  if (!paying) throw new Error('paying_outcome must name the outcome a paying customer records, like payment.');
  const signup = text(input.signup_outcome) || null;
  const by = text(input.break_down_by) || project.dimensions[0].id;
  if (isClickIdSignal(by)) throw new Error(`${by} is an ad click id, one per click; break down by source, utm_campaign, utm_term or another signal.`);
  const numbers = {};
  for (const [field, low, high] of [['revenue_months', 0, Infinity], ['gross_margin', -Infinity, 1], ['monthly_churn', 0, 1], ['customer_lifetime_months', 0, Infinity], ['target_ltv_to_cac', 0, Infinity]]) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== 'number' || !Number.isFinite(input[field]) || input[field] <= low || input[field] > high) throw new Error(`${field} must be a number above ${low}${Number.isFinite(high) ? ` and at most ${high}` : ''}.`);
    numbers[field] = input[field];
  }
  const months = numbers.revenue_months ?? 1;
  const target = numbers.target_ltv_to_cac ?? settings.target_ltv_to_cac;
  const currency = project.currency ?? 'USD';

  const visits = input.visits.map(visit => ({ kind: TRAFFIC_OBSERVER_FACT_KIND, projectId: project.projectId, observer_id: text(visit?.visitor), signals: object(visit?.signals) ? visit.signals : {} }));
  // A conversion naming no outcome counts toward the project's first one; only a paying outcome's value is revenue.
  const conversions = (Array.isArray(input.conversions) ? input.conversions : []).map(conversion => {
    const metric = text(conversion?.outcome) || project.conversionMetric;
    return { kind: TRAFFIC_CONVERSION_KIND, projectId: project.projectId, observer_id: text(conversion?.visitor), metric, ...(metric === paying && typeof conversion?.value === 'number' ? { value: conversion.value } : {}) };
  });
  const firstTouches = groupObserverFactsByProject(visits, conversions)[project.projectId]?.rows ?? [];

  const { rows: spent, from } = spendRows(input);
  const otherCurrency = [...new Set(spent.map(row => row.currency).filter(code => code && code.toUpperCase() !== currency.toUpperCase()))];
  if (otherCurrency.length) throw new Error(`Spend is in ${otherCurrency.join(', ')} but the project counts revenue in ${currency}; convert the spend or set project.currency so both are one currency.`);

  const groups = new Map();
  const group = value => groups.get(value) ?? groups.set(value, { rows: [], spend: 0, spent: false }).get(value);
  for (const row of firstTouches) group(text(row.signals?.[by]) || NOT_TAGGED).rows.push(row);
  let notMatched = 0;
  for (const row of spent) {
    const value = row.facts[by];
    if (!value) { notMatched += row.amount; continue; }
    const into = group(value);
    into.spend += row.amount;
    into.spent = true;
  }

  const unknown = new Set();
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency });
  const measure = (value, counts, spend) => {
    const revenuePerMonth = cents(counts.revenue) / months;
    const economics = computeUnitEconomics({
      net_revenue_cents: revenuePerMonth,
      gross_revenue_cents: revenuePerMonth,
      ...(numbers.gross_margin !== undefined ? { cost_of_delivery_cents: revenuePerMonth * (1 - numbers.gross_margin) } : {}),
      ...(spend === null ? {} : { acquisition_spend_cents: cents(spend) }),
      active_customers: counts.customers,
      new_customers: counts.customers,
      ...(numbers.customer_lifetime_months !== undefined ? { avg_lifetime_periods: numbers.customer_lifetime_months } : {}),
      ...(numbers.monthly_churn !== undefined ? { churn_rate: numbers.monthly_churn } : {}),
    });
    if (!spent.length) unknown.add(`No spend was given; give spend rows with ${by} set (or spend_answers read from a connected ad account) to get cost per sign-up, CAC, LTV:CAC and payback.`);
    if (!counts.customers) unknown.add(`A row with no ${paying} outcome has no CAC, revenue per customer, LTV or payback.`);
    if (numbers.gross_margin === undefined) unknown.add('LTV and payback need gross_margin (the share of revenue kept after the cost of delivering it).');
    if (numbers.monthly_churn === undefined && numbers.customer_lifetime_months === undefined) unknown.add('LTV needs monthly_churn or customer_lifetime_months.');
    const costPerSignup = spend === null || !counts.signups ? null : cents(spend) / counts.signups;
    const figures = {
      value,
      spend: spend === null ? null : units(cents(spend)),
      visitors: counts.visitors,
      signups: counts.signups,
      customers: counts.customers,
      revenue: units(cents(counts.revenue)),
      cost_per_signup: units(costPerSignup),
      cac: units(economics.cac_cents),
      revenue_per_customer_per_month: units(economics.arpu_cents),
      ltv: units(economics.ltv_cents),
      ltv_to_cac: rounded(economics.ltv_to_cac, 2),
      payback_months: rounded(economics.payback_periods, 2),
      meets_target: economics.ltv_to_cac === null ? null : economics.ltv_to_cac >= target,
    };
    const shown = (field, as) => (figures[field] === null ? '—' : as(figures[field]));
    return {
      ...figures,
      display: {
        spend: shown('spend', money.format), revenue: shown('revenue', money.format), cost_per_signup: shown('cost_per_signup', money.format),
        cac: shown('cac', money.format), revenue_per_customer_per_month: shown('revenue_per_customer_per_month', money.format), ltv: shown('ltv', money.format),
        ltv_to_cac: shown('ltv_to_cac', ratio => `${ratio}x`), payback_months: shown('payback_months', count => `${count} months`),
        meets_target: figures.meets_target === null ? '—' : figures.meets_target ? `Meets ${target}x` : `Below ${target}x`,
      },
    };
  };

  const rows = [...groups.entries()]
    .map(([value, { rows: touches, spend, spent: hasSpend }]) => measure(value, tally(touches, signup, paying), hasSpend ? spend : null))
    .sort((a, b) => (b.spend ?? -1) - (a.spend ?? -1) || b.visitors - a.visitors || a.value.localeCompare(b.value));
  const totalSpend = spent.length ? spent.reduce((sum, row) => sum + row.amount, 0) : null;
  const paidGroups = [...groups.values()].filter(item => item.spent);
  return {
    title: `Return on ad spend — ${project.label}`,
    break_down_by: by,
    currency,
    target_ltv_to_cac: target,
    revenue_months: months,
    spend_from: from,
    rows,
    paid: paidGroups.length ? measure('Paid', tally(paidGroups.flatMap(item => item.rows), signup, paying), paidGroups.reduce((sum, item) => sum + item.spend, 0)) : null,
    total: measure('All', tally(firstTouches, signup, paying), totalSpend),
    spend_not_matched: units(cents(notMatched)),
    unknown: [...unknown],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(`${JSON.stringify(measureAdReturn(JSON.parse(process.argv[2] ?? '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
