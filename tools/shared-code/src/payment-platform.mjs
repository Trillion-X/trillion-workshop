// src/payment-platform.mjs
//
// PURPOSE
//   Selling through a payment platform this service runs. A seller who has not brought their own payment account
//   connects one under the platform in one click (the vendor's own hosted onboarding page); from then on every request
//   their store sends for a sale (a checkout, a schedule, a read) acts for that account, and the requests that take
//   money carry the platform's fee. The platform rows, the fee rules and where a fee goes in a request are DATA
//   (src/payment-platform.json); a new platform is one row and nothing here names a vendor.
//
//   operator side   makePlatformOperator: runs in the operator account's PersonStore. The operator's existing
//                   service-connection box supplies the secret; the authenticated seller routes in worker.mjs bind
//                   onboarding and status to the caller's PersonStore identity.
//   seller side     feeFor + withPlatformFee: the seller's store picks its fee from the rules and places it in each
//                   capability request before it is built (src/negotiated-offers.mjs `prepare`).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A seller acts only for the account opened for that seller (seller_ref) in that mode; any other account is refused.
//   2. Live and test are READ from the vendor for each operator connection (mode_read), never typed or guessed.
//   3. One account per seller and mode: account creation carries an idempotency key named by both, and the record is kept
//      before the onboarding link is made.
//   4. The fee is placed only where a placement row says, rounded down, never above the lines' total.
//   5. A seller's own connection is never charged a fee (the seller store only prepares requests on the platform road).
//   6. Requests leave only for the platform row's allowed hosts.
import platformData from './payment-platform.json' with { type: 'json' };
import { buildStripeHttpRequest } from '../../seller-payment-setup/process/build-stripe-http-request.mjs';
import stripeOperations from '../../seller-payment-setup/data/stripe-operation-map.json' with { type: 'json' };

const text = value => typeof value === 'string' && value.trim() !== '';
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const at = (value, path) => path.reduce((found, key) => (found === undefined || found === null ? undefined : found[key]), value);
const MODES = ['live', 'test'];
const stripeOperation = id => stripeOperations.operations.find(row => row.operation_id === id);
function operationUrlMatches(operation, url) {
  if (!operation) return false;
  const escaped = operation.endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{provider_object_ref\\\}/g, '[^/]+');
  return new RegExp(`^${escaped}$`).test(url);
}

export class PaymentPlatformError extends Error {}

/** The platform row by id (src/payment-platform.json), or the first one. */
export function platformOf(id = null, data = platformData) {
  const rows = data.platforms ?? [];
  const row = id ? rows.find(item => item.id === id) : rows[0];
  if (!row) throw new PaymentPlatformError(`There is no payment platform ${id ?? ''}.`.trim());
  return row;
}

/** The fee in basis points for a seller's facts: the first rule whose `when` facts all equal. */
export function feeFor(platform, facts = {}) {
  const rule = (platform.fee?.rules ?? []).find(row => Object.entries(row.when ?? {}).every(([key, value]) => facts[key] === value));
  return Number.isSafeInteger(rule?.percent_bps) && rule.percent_bps >= 0 ? rule.percent_bps : 0;
}

const linesTotal = subject => (subject.line_items ?? []).reduce((sum, line) => {
  const amount = Number(line?.price_data?.unit_amount ?? line?.amount ?? 0);
  const quantity = Number(line?.quantity ?? 1);
  return Number.isFinite(amount) && Number.isFinite(quantity) ? sum + amount * quantity : sum;
}, 0);

const setAt = (value, path, placed) => {
  const copy = structuredClone(value);
  let here = copy;
  for (const key of path.slice(0, -1)) {
    if (!object(here[key])) here[key] = {};
    here = here[key];
  }
  here[path.at(-1)] = placed;
  return copy;
};

/**
 * A capability request ({ operation_id, input_facts: { operation_subject } }) with the platform fee placed where a
 * placement row for its operation and subject mode says. A request no row names comes back unchanged.
 */
export function withPlatformFee(platform, bps) {
  return request => {
    const subject = request?.input_facts?.operation_subject;
    if (!bps || !object(subject)) return request;
    const row = (platform.fee?.placements ?? []).find(item => item.operation_id === request.operation_id
      && (item.subject_mode === null || item.subject_mode === subject.mode));
    if (!row) return request;
    let placed;
    if (row.as === 'percent') placed = bps / 100;
    else if (row.as === 'amount_of_lines') {
      const total = linesTotal(subject);
      placed = Math.min(total, Math.floor((total * bps) / 10000));
      if (!placed) return request;
    } else throw new PaymentPlatformError(`A fee placed "${row.as}" is not a way this service places fees.`);
    return { ...request, input_facts: { ...request.input_facts, operation_subject: setAt(subject, row.path, placed) } };
  };
}

/** Bind the operator API to the seller whose PersonStore created this wrapper. The caller never supplies seller_ref. */
export function forPlatformSeller(operator, sellerRef) {
  if (!object(operator) || !text(sellerRef)) throw new PaymentPlatformError('This seller payment account is unavailable.');
  return Object.freeze({
    start: ({ mode, return_url, refresh_url, email = null, name = null } = {}) => operator.start({
      seller_ref: sellerRef, mode, return_url, refresh_url, email, name,
    }),
    status: ({ mode } = {}) => operator.status({ seller_ref: sellerRef, mode }),
    act: ({ mode, request } = {}) => operator.act({ seller_ref: sellerRef, mode, request }),
  });
}

/**
 * The operator side. seams:
 *   connections(): the operator's connections [{ connection_id, vendor, status }]
 *   send(built, connectionId): sends one built request with that connection's secret placed, answers the JSON reply
 *     (throws on a non-2xx answer with the vendor's own message)
 *   read(key) / write(key, value): this store's own values
 */
export function makePlatformOperator({ platform = platformOf(), connections, send, read, write, now = () => new Date().toISOString() }) {
  const allowed = new Set(platform.allowed_hosts ?? []);
  const recordKey = (sellerRef, mode) => `platform-seller:${platform.id}:${mode}:${sellerRef}`;
  const checkMode = mode => { if (!MODES.includes(mode)) throw new PaymentPlatformError('Choose live or test.'); return mode; };
  const checkSeller = sellerRef => { if (!text(sellerRef)) throw new PaymentPlatformError('Which seller this is for is missing.'); return sellerRef; };

  // Each operator connection of the platform's vendor, its mode read once from the vendor and kept.
  async function connectionFor(mode) {
    const listed = (await connections()).filter(item => item.vendor === platform.vendor && (item.status === 'connected' || item.status === undefined));
    listed.sort((a, b) => (a.connection_id === platform.own_connection ? -1 : b.connection_id === platform.own_connection ? 1 : 0));
    for (const item of listed) {
      // A connection id can be reconnected to a different Stripe key. Read livemode each time so a cached mode
      // can never route a seller to a new credential under the old mode.
      let known;
      try {
        const answer = await send(buildStripeHttpRequest({ operation_id: platform.mode_read.operation_id, input_facts: {} }), item.connection_id);
        const live = at(answer, platform.mode_read.live_field);
        if (typeof live !== 'boolean') continue;
        known = live ? 'live' : 'test';
      } catch { continue; }
      if (known === mode) return item.connection_id;
    }
    throw new PaymentPlatformError(`This service has no ${platform.label} ${mode} account to run the platform on.`);
  }

  const shownAccount = (record, account) => ({
    platform: platform.id, mode: record.mode, account: record.account,
    ready: (platform.account.facts?.ready ?? []).every(field => account?.[field] === true),
    submitted: (platform.account.facts?.submitted ?? []).every(field => account?.[field] === true),
    payouts: (platform.account.facts?.payouts ?? []).every(field => account?.[field] === true),
    dashboard_url: platform.account.dashboard_url,
  });

  /** Open (or find) this seller's account in this mode and make a fresh onboarding link for it. */
  async function start({ seller_ref: sellerRef, mode, return_url: returnUrl, refresh_url: refreshUrl, email = null, name = null } = {}) {
    checkSeller(sellerRef); checkMode(mode);
    if (!text(returnUrl) || !text(refreshUrl)) throw new PaymentPlatformError('Give the addresses to come back to after onboarding.');
    const connection = await connectionFor(mode);
    let record = read(recordKey(sellerRef, mode));
    if (!record?.account) {
      const made = await send(buildStripeHttpRequest({
        operation_id: platform.account.create,
        idempotency_key: recordKey(sellerRef, mode),
        input_facts: { operation_subject: {
          ...structuredClone(platform.account.subject),
          ...(text(email) ? { email: email.trim() } : {}),
          ...(text(name) ? { business_profile: { name: name.trim() } } : {}),
          metadata: { seller_ref: sellerRef, platform: platform.id },
        } },
      }), connection);
      if (!text(made?.id)) throw new PaymentPlatformError(`${platform.label} did not open an account.`);
      record = { seller_ref: sellerRef, mode, account: made.id, opened_at: now() };
      write(recordKey(sellerRef, mode), record);
    }
    const link = await send(buildStripeHttpRequest({
      operation_id: platform.account.onboarding_link,
      input_facts: { operation_subject: { account: record.account, type: platform.account.onboarding_type, return_url: returnUrl, refresh_url: refreshUrl } },
    }), connection);
    if (!text(link?.url)) throw new PaymentPlatformError(`${platform.label} did not make an onboarding page.`);
    return { platform: platform.id, mode, account: record.account, url: link.url };
  }

  /** This seller's account in this mode, read now from the vendor. */
  async function status({ seller_ref: sellerRef, mode } = {}) {
    checkSeller(sellerRef); checkMode(mode);
    const record = read(recordKey(sellerRef, mode));
    if (!record?.account) return { platform: platform.id, mode, account: null, ready: false };
    const account = await send(buildStripeHttpRequest({ operation_id: platform.account.read, input_facts: { provider_object_ref: record.account } }), await connectionFor(mode));
    return shownAccount(record, account);
  }

  /** One built request sent for this seller's own account in this mode. */
  async function act({ seller_ref: sellerRef, mode, request } = {}) {
    checkSeller(sellerRef); checkMode(mode);
    const record = read(recordKey(sellerRef, mode));
    if (!record?.account) throw new PaymentPlatformError(`This seller has no ${platform.label} account through Trillion in ${mode} mode.`);
    if (!object(request) || !text(request.operation_id) || (request.prepared !== true && !object(request.input_facts))) throw new PaymentPlatformError('The Stripe operation to send is missing.');
    if (!(platform.allowed_operations ?? []).includes(request.operation_id)) throw new PaymentPlatformError('This Stripe operation is not available for a seller account.');
    let built;
    if (request.prepared === true) {
      built = request;
      if (!text(built.url) || !['GET', 'POST', 'DELETE'].includes(built.method)) throw new PaymentPlatformError('This Stripe operation could not be prepared.');
      const operation = stripeOperation(request.operation_id);
      if (!operation || operation.method !== built.method || !operationUrlMatches(operation, built.url)) {
        throw new PaymentPlatformError('This Stripe operation does not match its declared address.');
      }
    } else {
      try {
        built = buildStripeHttpRequest({ operation_id: request.operation_id, input_facts: request.input_facts,
          ...(text(request.idempotency_key) ? { idempotency_key: request.idempotency_key } : {}) });
      } catch { throw new PaymentPlatformError('This Stripe operation could not be prepared.'); }
    }
    if (!URL.canParse(built.url) || new URL(built.url).protocol !== 'https:' || !allowed.has(new URL(built.url).hostname)) {
      throw new PaymentPlatformError(`Only ${[...allowed].join(', ')} can be reached for a seller.`);
    }
    const headers = Object.fromEntries(Object.entries(object(built.headers) ? built.headers : {})
      .filter(([name]) => ['stripe-version', 'idempotency-key', 'content-type'].includes(name.toLowerCase())));
    headers[platform.acting_header] = record.account;
    return send({ url: built.url, method: built.method, headers, ...(typeof built.body === 'string' ? { body: built.body } : {}) }, await connectionFor(mode));
  }

  return { connectionFor, start, status, act };
}
