// src/business-screen.mjs
//
// PURPOSE
//   Business, every signed-in person's screen about their own business: what came in this month on the payment
//   service they connected (money in, that service's fees, money returned, net, and how many payments), read with their
//   own connection. The operator account also sees Trillion's paid plans on its payment service, its price tests and how
//   people use Trillion. Business is a Marketplace catalogue screen (records/marketplace-screens.json tool:business),
//   drawn by the generic screen host (src/screen-host.mjs) from one read, tool:read-business (the account action
//   read-business): this file reads the facts (readBusiness) and writes them as the words and figures the layout places
//   (businessFacts). Nothing here writes markup or a screen description.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only real figures: every amount is summed from entries the person's own payment service answered. A read that
//      failed or took too long says so and shows no number; a read cut short at its limit says the figures count only
//      the latest entries.
//   2. Amounts stay in each currency's smallest unit until they are written, and are never added across currencies.
//   3. Which services can be read, and how, is DATA (src/money-reads.json); a new payment service is a row there.
//   4. The operator's part is read only for the operator account, and price tests only from the service's book.
//
// raw facts for businessFacts: { since: ISO time (the first of this month, UTC),
//   services: [{ label, connected, money: tally | null | undefined }] (undefined: not read, since not connected),
//   operator?: { payment_service: { label, connected }, payments: { mode, set_up_by, links } | null,
//                usage: { calls_7d, refused_7d, apps },
//                price_tests: [results of src/price-experiments.mjs experimentResults, each arm with offer_id and open] | null } }
//   (price_tests null: the tests could not be read just now.)
//   tally: { currencies: [{ currency, money_in, fees, refunded, net }], payments, more, at_most }
import moneyReads from './money-reads.json' with { type: 'json' };
import { loadWorkshopRows } from './stored-checks.mjs';
import { priceExperimentsState, readPaymentConfig } from './payment.mjs';
import { optionalRead } from './optional-read.mjs';

/** The first moment of this month, UTC. */
export const monthStart = now => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** An amount in a currency's smallest unit, written in that currency (cents shown only when there are some). */
export function moneyWords(minor, currency) {
  const code = String(currency).toUpperCase();
  const digits = new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits;
  const unit = 10 ** digits;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, minimumFractionDigits: minor % unit ? digits : 0, maximumFractionDigits: digits }).format(minor / unit);
}

/**
 * The payment services whose money can be read (src/money-reads.json), each with its name and whether this person
 * connected it. A service's name and vendor come from the read tool's own connection and that service's connect row.
 * rows: the Workshop's tool rows ({ tools }); connections: the person's connections ([{ vendor, ... }]).
 */
export function moneyServices(rows, connections) {
  return moneyReads.reads.flatMap(read => {
    const tool = rows.tools.find(item => item.id === read.tool_id);
    if (!tool) return [];
    const vendor = String(tool.invoke?.connection_id ?? '').split(':').pop();
    const service = rows.tools.find(item => item.invoke?.connects && item.invoke.provider === vendor);
    return [{ read, label: service?.label ?? vendor, connected: connections.some(item => item.vendor === vendor) }];
  });
}

/**
 * Sum one money read's answer per currency. Answers null when the answer holds no list, so a malformed answer is
 * said as unreadable rather than shown as nothing taken in.
 */
export function tallyMoney(read, answer) {
  const entries = answer?.[read.list];
  if (!Array.isArray(entries)) return null;
  const byCurrency = new Map();
  let payments = 0;
  for (const entry of entries) {
    const kind = read.kinds[entry[read.fields.kind]];
    if (!kind) continue;
    const currency = String(entry[read.fields.currency]).toLowerCase();
    const sums = byCurrency.get(currency) ?? { currency, money_in: 0, fees: 0, refunded: 0, net: 0 };
    const amount = Number(entry[read.fields.amount] ?? 0);
    if (kind === 'payment') { sums.money_in += amount; payments += 1; } else sums.refunded -= amount;
    sums.fees += Number(entry[read.fields.fee] ?? 0);
    sums.net += Number(entry[read.fields.net] ?? 0);
    byCurrency.set(currency, sums);
  }
  return { currencies: [...byCurrency.values()], payments, more: answer[read.more] === true, at_most: read.at_most };
}

/**
 * Read this month's money on every connected payment service. `run(tool_id, input)` runs a tool with the person's own
 * connection and answers its output, or null when it failed or took too long.
 */
export async function readMoney({ services, run, since }) {
  const seconds = Math.floor(since.getTime() / 1000);
  return Promise.all(services.map(async ({ read, label, connected }) => {
    if (!connected) return { label, connected, money: undefined };
    const answer = await run(read.tool_id, { [read.since_input]: seconds });
    return { label, connected, money: answer === null ? null : tallyMoney(read, answer) };
  }));
}

// One connected service's money as the layout writes it: unread, nothing this month, or each currency's figures.
function moneyFacts({ label, money }) {
  if (money === null) return { label, state: 'unread' };
  if (!money.currencies.length) return { label, state: 'none' };
  const multi = money.currencies.length > 1;
  return {
    label, state: 'read', payments: money.payments, more: money.more, at_most: money.at_most,
    currencies: money.currencies.map(sums => ({
      currency: sums.currency, code: sums.currency.toUpperCase(), multi, service_label: label,
      money_in: moneyWords(sums.money_in, sums.currency), fees: moneyWords(sums.fees, sums.currency),
      refunded: sums.refunded ? moneyWords(sums.refunded, sums.currency) : null, net: moneyWords(sums.net, sums.currency),
    })),
  };
}

const cents = value => (value === null || value === undefined ? '-' : moneyWords(value, 'usd'));

// The operator's part as the layout writes it: its price tests (each price, who saw it and paid, the money it brought
// in and that money per person shown), its paid plans and how people use Trillion.
function operatorFacts({ payment_service: service, payments, usage, price_tests: tests }) {
  return {
    service: { label: service.label, connected: service.connected },
    payments: payments ? { mode: payments.mode ?? 'live', links: payments.links ?? 0 } : null,
    usage: { calls_7d: usage.calls_7d, refused_7d: usage.refused_7d, apps: usage.apps.slice(0, 5).map(app => ({ key: app.app ?? 'unknown', name: app.app ?? null, calls: app.calls })) },
    price_tests: tests === null ? null : (tests ?? []).map(test => ({
      id: test.id, label: test.label, state: test.state, optimizing_for: test.optimizing_for || null,
      arms: test.arms.map(arm => ({
        test_id: test.id, running: test.state === 'running', arm: arm.arm, label: arm.label, shown: arm.shown, paid: arm.paid,
        money: cents(arm.money_cents), per_shown: cents(arm.money_per_shown_cents), waiting_for_link: arm.open === false,
        mark: test.result?.winner === arm.arm ? 'winner' : test.leading === arm.arm ? 'leading' : null,
      })),
    })),
  };
}

/** Business's facts (tool:read-business answers them; tool:business draws them) from the raw facts above. */
export function businessFacts(facts) {
  return {
    since_words: new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(facts.since)),
    service_names: facts.services.map(service => service.label),
    connected: facts.services.filter(service => service.connected).map(moneyFacts),
    operator: facts.operator ? operatorFacts(facts.operator) : null,
  };
}

/** The tool that sets up Trillion's paid plans on the operator's payment service. */
export const PAID_PLAN_TOOL = 'tool:set-up-paid-plan';

// The operator's part of Business: Trillion's paid plans on its payment service and how people use Trillion. The payment
// service is whichever service the paid-plan tool's row connects to, and its name is that service's row.
async function operatorBusiness(env, pool, rows, connections) {
  const [payments, stats] = await Promise.all([readPaymentConfig(env), pool.callStats()]);
  // Trillion's own price tests, read from the service's book (src/record-book.mjs), never a person's store.
  const tests = await optionalRead(() => priceExperimentsState(env, payments), null);
  const week = (stats.days ?? []).slice(0, 7);
  const vendor = String(rows.tools.find(tool => tool.id === PAID_PLAN_TOOL)?.invoke?.connection_id ?? '').split(':').pop();
  const paymentRow = rows.tools.find(tool => tool.invoke?.connects && tool.invoke.provider === vendor);
  return {
    payment_service: { label: paymentRow?.label ?? vendor, connected: connections.some(item => item.vendor === vendor) },
    payments: payments ? { mode: payments.mode ?? null, set_up_by: payments.set_up_by ?? null, links: (payments.links ?? []).length } : null,
    usage: { calls_7d: week.reduce((sum, row) => sum + Number(row.calls ?? 0), 0), refused_7d: week.reduce((sum, row) => sum + Number(row.refused ?? 0), 0), apps: stats.apps ?? [] },
    price_tests: tests,
  };
}

/**
 * Business's facts for one account: this month's money on every payment service it connected, each read with its own
 * connection through `run(tool_id, input)` (the account's tool runner; a failed or slow read is unread), and, when
 * `pool` is given (the operator account only), the operator's part read from the service's call pool.
 */
export async function readBusiness({ env, connections, run, pool = null, now = new Date() }) {
  const rows = await loadWorkshopRows(env);
  const since = monthStart(now);
  const [services, operator] = await Promise.all([
    readMoney({ services: moneyServices(rows, connections), since, run: (toolId, input) => optionalRead(() => run(toolId, input), null) }),
    pool ? operatorBusiness(env, pool, rows, connections) : undefined,
  ]);
  return businessFacts({ since: since.toISOString(), services, operator });
}
