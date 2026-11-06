// tools/see-what-my-business-took-in-this-month/do-work/business-screen.mjs
//
// PURPOSE
//   Business, every signed-in person's screen about their own business: what came in this month on the payment
//   service they connected (money in, that service's fees, money returned, net, and how many payments), read with their
//   own connection. The operator account also sees Trillion's paid plans on its payment service, its price tests and how
//   people use Trillion. Business is a catalogue screen (tool:business in
//   tools/show-my-screens-from-a-catalogue-of-reads-and-layouts), drawn by the engine's generic screen host
//   (GET /work/api/screens/business) from one read, tool:read-business (this folder's row, readBusinessForScreen): this
//   file reads the facts (readBusiness) and writes them as the words and figures the layout places (businessFacts).
//   Nothing here writes markup or a screen description.
//
//   Ported from old trillion src/business-screen.mjs (Trillion-X/trillion before 4ffa1dc4a2), where the account action
//   read-business ran it. What changed, and why:
//     - The money read runs as a nested Workshop run (the row declares tool:stripe-events-read_money_since in
//       invoke.records.runs), with the person's own Stripe connection held by the engine's vault, as old runTool did.
//     - Which payment services the person connected has no owner today: old trillion read it from the account's
//       held-values connection summaries (connectionsNow: held operation `list`, src/connection-summaries.mjs, the
//       tool:list-connections row). Nothing a Workshop run can reach keeps that list, so `connections` is null
//       (unknown). An unknown connection is never said to be connected or not: its money is read with the person's own
//       connection, and a read that fails (no key held, a refusal, too slow) is drawn as old Business drew a failed
//       read, "could not be read just now", with no number. Given the list (connections), it draws exactly as before.
//     - The operator's part has no owner today either: whether this account is the operator (env.OPERATOR_ACCOUNT_ID),
//       the service's payment config (src/payment.mjs readPaymentConfig), its call pool's use (pool.callStats) and the
//       price tests in the service's book (priceExperimentsState) were the hosted service's own stores. So readBusiness
//       reads no operator part, and Business is drawn as every other account saw it. operatorFacts and its layout are
//       kept, drawn from given facts.
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
import { readFileSync } from 'node:fs';
import moneyReads from '../../money-reads/src/money-reads.json' with { type: 'json' };
import toolRows from '../tool-rows.json' with { type: 'json' };

// The service-connection descriptors (one per service a person can connect) the old connect rows were made from
// (tool-row-source source:service-connection-descriptors: id_prefix tool:connect-service-, label from `name`, provider
// from `vendor`); a service's name comes from its row, as before.
const SERVICES = new URL('../../connect-a-service-and-seal-its-key/records.json', import.meta.url);
const CONNECT_ROW_PREFIX = 'tool:connect-service-';

/** The rows moneyServices reads ({ tools }): this folder's rows (the money reads) and each service's connect row. */
export function workshopRows(services = JSON.parse(readFileSync(SERVICES, 'utf8'))) {
  const connectRows = services.things.map(thing => thing.payload).filter(payload => payload?.kind === 'service-connection-descriptor')
    .map(payload => ({ id: `${CONNECT_ROW_PREFIX}${payload.vendor}`, label: payload.name, invoke: { kind: 'held-values', operation: 'connect', provider: payload.vendor, connects: { connection: payload.vendor } } }));
  return { tools: [...toolRows.records.map(record => record.payload), ...connectRows] };
}

// old src/optional-read.mjs, unchanged.
export const OPTIONAL_READ_MS = 8000;

/** `read()`'s value, or `fallback` when it threw or took longer than `waitMs`. */
export async function optionalRead(read, fallback, waitMs = OPTIONAL_READ_MS) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise(resolve => { timer = setTimeout(() => resolve(fallback), waitMs); }),
    ]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

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
 * rows: the Workshop's tool rows ({ tools }); connections: the person's connections ([{ vendor, ... }]), or null when
 * they cannot be read (then `connected` is null: unknown).
 */
export function moneyServices(rows, connections) {
  return moneyReads.reads.flatMap(read => {
    const tool = rows.tools.find(item => item.id === read.tool_id);
    if (!tool) return [];
    const vendor = String(tool.invoke?.connection_id ?? '').split(':').pop();
    const service = rows.tools.find(item => item.invoke?.connects && item.invoke.provider === vendor);
    return [{ read, label: service?.label ?? vendor, connected: connections === null ? null : connections.some(item => item.vendor === vendor) }];
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
 * Read this month's money on every connected payment service (and on each whose connection is unknown: the read itself
 * then says whether the person's own connection answers). `run(tool_id, input)` runs a tool with the person's own
 * connection and answers its output, or null when it failed or took too long.
 */
export async function readMoney({ services, run, since }) {
  const seconds = Math.floor(since.getTime() / 1000);
  return Promise.all(services.map(async ({ read, label, connected }) => {
    if (connected === false) return { label, connected, money: undefined };
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
    connected: facts.services.filter(service => service.connected !== false).map(moneyFacts),
    operator: facts.operator ? operatorFacts(facts.operator) : null,
  };
}

/**
 * Business's facts for one account: this month's money on every payment service it connected, each read with its own
 * connection through `run(tool_id, input)` (the account's tool runner; a failed or slow read is unread). `connections`
 * null: they cannot be read (see PURPOSE). The operator's part is not read (no owner today, see PURPOSE).
 */
export async function readBusiness({ rows = workshopRows(), connections, run, now = new Date() }) {
  const since = monthStart(now);
  const services = await readMoney({ services: moneyServices(rows, connections), since, run: (toolId, input) => optionalRead(() => run(toolId, input), null) });
  return businessFacts({ since: since.toISOString(), services, operator: undefined });
}

/**
 * tool:read-business, the one read of the Business screen: { now? } → Business's facts for the page's account. Each
 * money read is a nested run through this run's door (contract A), keyed by the read and its moment, so a retried read
 * asks again under the same key. `now` (an ISO time) is only for a sample run; the month is this one otherwise.
 */
export async function readBusinessForScreen(input = {}, { door } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Send one JSON object: { now? }.');
  const now = input.now === undefined ? new Date() : new Date(input.now);
  if (!Number.isFinite(now.getTime())) throw new Error('now must be an ISO time, for example 2026-10-15T00:00:00.000Z.');
  return readBusiness({ connections: null, now, run: (toolId, given) => door.run(toolId, given, { key: `${toolId}:${JSON.stringify(given)}` }) });
}
