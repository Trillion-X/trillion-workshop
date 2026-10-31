// tools/trading/read-data/trading.mjs
//
// The trading runs a row starts: place the orders of a trading policy at the person's broker, check placed orders
// with the broker, and look up instruments the broker lists. Each run has one mode, paper or live, fixed by its row:
// the row holds only that mode's broker credentials, may touch only that mode's records (ids start "paper-" or
// "live-"), and every order and route must say the same mode.
//
// Records (through the run's records door, descriptor 3):
//   trade-order      <mode>-<policy_version>-<content key>   the one record of an order: what was decided, what was
//                                                            sent, and the broker's real state
//   trade-order-event <order_id>-sent | <order_id>-checked-<ms>  append-only trail: the request as kept (no held
//                                                            value) and the broker's answer
//   trade-day-spend  <mode>-<YYYY-MM-DD>                     the notional sent that day, in the policy's time zone
//
// Invariants:
// - No order is sent without a policy that names its own limits and a route of the run's mode; with none, the run
//   refuses and says what to give.
// - An order's record is written before its request leaves, so an answer lost in transit leaves "unknown", which the
//   next run never sends again; checking it with the broker resolves it.
// - A broker answer of HTTP 4xx is a refusal: nothing was placed and the day's spend is given back. 5xx and no answer
//   are "unknown". Only a 2xx answer is read for the order's real state.
// - Held values reach only the request; records, events and answers never carry one.
import { readFileSync } from 'node:fs';
import { decide } from './decide-orders.mjs';
import { bodyOf, lookupRequest, orderRequest, readLookupAnswer, readOrderAnswer, statusRequest, withCredentials } from './broker-requests.mjs';
import { isObject, listOf, missing, numberOf, objectOf } from './values.mjs';

const MODES = { paper: 'paper-broker-credentials', live: 'live-broker-credentials' };
const CREDENTIAL_DESCRIPTOR = 4;
const KEPT_ANSWER_CHARS = 4000;
const POLICY_VERSION = /^[A-Za-z0-9._:-]{1,64}$/;
const ALWAYS_OPEN = ['sending', 'unknown'];

const POLICY_SHAPE = 'policy: { policy_version, decided_at?, orders: [{ instrument: { symbol, kind?, contract_multiplier? }, side, qty, order_type, limit_price?, time_in_force?, live, route_ref }], risk: { max_order_notional, max_daily_notional, day_time_zone } }';
const ROUTE_SHAPE = 'routes: { <route_ref>: { mode, instrument_requests, credential_injections, response_map, status_map, status_request?, open_statuses? } }';

/** The held broker credentials of this mode: a JSON object of named text fields, read once from its descriptor. */
function heldCredentials(mode, context) {
  let held = context.held;
  if (held === undefined) {
    try { held = JSON.parse(readFileSync(CREDENTIAL_DESCRIPTOR, 'utf8')); } catch { held = null; }
  }
  if (!isObject(held)) throw new Error(`The held value ${MODES[mode]} must be a JSON object of named fields, such as { "key_id": "...", "secret": "..." }; store it again in that shape.`);
  return held;
}

function routesOf(input, mode) {
  const routes = objectOf(input.routes);
  if (Object.keys(routes).length === 0) throw new Error(`No broker routes were given, so nothing was sent. Give ${ROUTE_SHAPE}, with mode "${mode}".`);
  return routes;
}

/** The day in a time zone, YYYY-MM-DD. */
function dayIn(timeZone, now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(now)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The policy as given, checked for what a run needs before it may send anything. */
function checkedPolicy(input, mode) {
  const policy = input.policy;
  if (!isObject(policy)) throw new Error(`No trading policy was given, so no order was placed. Give ${POLICY_SHAPE}, each order with live: ${mode === 'live'}.`);
  const version = policy.policy_version;
  if (!(Number.isInteger(version) || (typeof version === 'string' && POLICY_VERSION.test(version)))) {
    throw new Error('policy.policy_version must be a whole number or 1 to 64 letters, digits, ".", "_", ":" or "-"; give a new one for each new set of decisions.');
  }
  const risk = objectOf(policy.risk);
  for (const limit of ['max_order_notional', 'max_daily_notional']) {
    const value = numberOf(risk[limit]);
    if (value === null || value < 0) throw new Error(`policy.risk.${limit} must be a number the policy sets; no order is placed without both limits.`);
  }
  try { dayIn(risk.day_time_zone, 0); } catch { throw new Error('policy.risk.day_time_zone must name the time zone the daily limit is counted in, such as "America/New_York".'); }
  if (!Array.isArray(policy.orders)) throw new Error(`policy.orders must be a list of orders. Give ${POLICY_SHAPE}.`);
  return policy;
}

/** Send one request; the answer is { status_code, body } or { lost: reason } when no answer came. */
async function send(request, fetchImpl) {
  const signal = AbortSignal.timeout(request.timeout_ms);
  try {
    const response = await fetchImpl(request.url, { method: request.method, headers: request.headers, body: request.body ?? undefined, signal });
    return { status_code: response.status, body: await response.text() };
  } catch (error) {
    return { lost: error?.name === 'TimeoutError' ? 'the broker did not answer in time' : 'the request did not reach the broker or its answer was lost' };
  }
}

const kept = text => (typeof text === 'string' && text.length > KEPT_ANSWER_CHARS ? `${text.slice(0, KEPT_ANSWER_CHARS)}…` : text);

/** What a broker answer means for an order: its new fields and status. */
function outcomeOf(answer, route) {
  if (answer.lost) return { status: 'unknown', note: answer.lost, http_status: null };
  if (answer.status_code >= 200 && answer.status_code < 300) return readOrderAnswer(answer, route);
  if (answer.status_code >= 400 && answer.status_code < 500) return { status: 'refused', note: 'the broker refused the order', http_status: answer.status_code };
  return { status: 'unknown', note: `the broker answered HTTP ${answer.status_code}`, http_status: answer.status_code };
}

const eventOf = (order, step, at, shown, answer) => ({
  order_id: order.order_id, mode: order.mode, step, at, request: shown,
  http_status: answer.status_code ?? null, answer: answer.lost ? null : kept(bodyOf(answer.body)), note: answer.lost ?? null,
});

async function placeOrders(mode, input, context) {
  const policy = checkedPolicy(input, mode);
  const routes = routesOf(input, mode);
  const { door } = context;
  const fetchImpl = context.fetchImpl ?? fetch;
  const now = () => (context.now ? context.now() : Date.now());
  const risk = policy.risk;
  const day = dayIn(risk.day_time_zone, now());
  const spendId = `${mode}-${day}`;
  const spent = objectOf(await door.read('trade-day-spend', spendId));
  let dayUsed = numberOf(spent.notional) ?? 0;

  const existing = [];
  for await (const record of door.list({ type: 'trade-order', prefix: `${mode}-${policy.policy_version}-` })) existing.push(record.value?.idempotency_key);
  const decided = decide({ mode, policy, routes, prices: objectOf(input.prices), existing, dayUsed });

  const placed = [];
  const skipped = [...decided.skipped];
  const held = decided.orders.length ? heldCredentials(mode, context) : null;
  for (const order of decided.orders) {
    const route = routes[order.route_ref];
    let request;
    try {
      request = withCredentials(orderRequest(order, route), route, held, { heldName: MODES[mode], now: now() });
    } catch (error) {
      skipped.push({ instrument: order.instrument, side: order.side, reason: `route ${order.route_ref} cannot build this order: ${error.message}`, idempotency_key: order.idempotency_key });
      continue;
    }
    const sentAt = new Date(now()).toISOString();
    const record = { ...order, day, time_zone: risk.day_time_zone, status: 'sending', sent_at: sentAt, broker_order_id: null, broker_status: null, filled_qty: 0, filled_avg_price: null, filled_at: null, http_status: null };
    dayUsed += order.notional;
    await door.write([
      { id: order.order_id, type: 'trade-order', value: record },
      { id: spendId, type: 'trade-day-spend', value: { mode, day, time_zone: risk.day_time_zone, notional: dayUsed } },
    ], { key: `send:${order.order_id}` });

    const answer = await send(request.send, fetchImpl);
    const outcome = outcomeOf(answer, route);
    const after = { ...record, ...outcome, checked_at: new Date(now()).toISOString() };
    const writes = [
      { id: order.order_id, type: 'trade-order', value: after },
      { id: `${order.order_id}-sent`, type: 'trade-order-event', value: eventOf(order, 'sent', sentAt, request.shown, answer) },
    ];
    if (outcome.status === 'refused') {
      dayUsed -= order.notional;
      writes.push({ id: spendId, type: 'trade-day-spend', value: { mode, day, time_zone: risk.day_time_zone, notional: dayUsed } });
    }
    await door.write(writes, { key: `sent:${order.order_id}` });
    placed.push({
      order_id: order.order_id, instrument: order.instrument, side: order.side, qty: order.qty, notional: order.notional,
      status: after.status, broker_order_id: after.broker_order_id ?? null, filled_qty: after.filled_qty ?? 0,
      filled_avg_price: after.filled_avg_price ?? null, http_status: after.http_status ?? null, note: after.note ?? null,
    });
  }
  const said = `${mode === 'live' ? 'Live' : 'Paper'} run of policy ${policy.policy_version}: ${placed.length} sent, ${skipped.length} skipped; ${dayUsed} of ${risk.max_daily_notional} used on ${day}.`;
  return { mode, policy_version: policy.policy_version, placed, skipped, day: { day, used: dayUsed, limit: numberOf(risk.max_daily_notional) }, said };
}

async function checkOrders(mode, input, context) {
  const routes = routesOf(input, mode);
  const { door } = context;
  const fetchImpl = context.fetchImpl ?? fetch;
  const now = () => (context.now ? context.now() : Date.now());
  const wanted = Array.isArray(input.order_ids) ? new Set(input.order_ids) : null;
  const orders = [];
  for await (const record of door.list({ type: 'trade-order', prefix: `${mode}-` })) {
    if (!wanted || wanted.has(record.id)) orders.push(record.value);
  }
  // Orders named by id are checked whatever their status; otherwise only the open ones are.
  const open = [];
  const couldNotCheck = [];
  for (const order of orders) {
    const route = isObject(routes[order.route_ref]) && routes[order.route_ref].mode === mode ? routes[order.route_ref] : null;
    const openStatuses = [...ALWAYS_OPEN, ...listOf(route?.open_statuses)];
    if (!wanted && !openStatuses.includes(order.status)) continue;
    if (!route) { couldNotCheck.push({ order_id: order.order_id, reason: `no ${mode} route ${order.route_ref} was given` }); continue; }
    open.push({ order, route });
  }
  const checked = [];
  const held = open.length ? heldCredentials(mode, context) : null;
  for (const { order, route } of open) {
    let request;
    try {
      request = withCredentials(statusRequest(order, route), route, held, { heldName: MODES[mode], now: now() });
    } catch (error) {
      couldNotCheck.push({ order_id: order.order_id, reason: error.message });
      continue;
    }
    const at = now();
    const answer = await send(request.send, fetchImpl);
    const writes = [{ id: `${order.order_id}-checked-${at}`, type: 'trade-order-event', value: eventOf(order, 'checked', new Date(at).toISOString(), request.shown, answer) }];
    let after = order;
    if (answer.status_code >= 200 && answer.status_code < 300) {
      after = { ...order, ...readOrderAnswer(answer, route), note: null, checked_at: new Date(at).toISOString() };
    } else if (answer.status_code === 404 && missing(order.broker_order_id) && ALWAYS_OPEN.includes(order.status)) {
      // The broker has no such order and never named one: it was not placed, and its day's spend is given back.
      after = { ...order, status: 'not-placed', http_status: 404, note: 'the broker has no such order', checked_at: new Date(at).toISOString() };
      const spendId = `${mode}-${order.day}`;
      const spent = objectOf(await door.read('trade-day-spend', spendId));
      writes.push({ id: spendId, type: 'trade-day-spend', value: { ...spent, notional: (numberOf(spent.notional) ?? 0) - order.notional } });
    } else {
      couldNotCheck.push({ order_id: order.order_id, reason: answer.lost ?? `the broker answered HTTP ${answer.status_code}` });
    }
    if (after !== order) writes.push({ id: order.order_id, type: 'trade-order', value: after });
    await door.write(writes, { key: `check:${order.order_id}:${at}` });
    if (after !== order) {
      checked.push({ order_id: order.order_id, status: after.status, broker_status: after.broker_status ?? null, filled_qty: after.filled_qty ?? 0, filled_avg_price: after.filled_avg_price ?? null, filled_at: after.filled_at ?? null });
    }
  }
  return { mode, checked, could_not_check: couldNotCheck, said: `${checked.length} ${mode} orders checked with the broker, ${couldNotCheck.length} could not be checked.` };
}

async function lookUp(mode, input, context) {
  const route = input.route;
  if (!isObject(route)) throw new Error(`No broker route was given. Give route: { mode: "${mode}", credential_injections, lookups: { <name>: { url, query?, query_names?, items_at?, id_field?, keep_when?, numbers?, whole_numbers?, keep_fields?, sort_by?, next_at? } } }, lookup: <name> and query.`);
  if (route.mode !== mode) throw new Error(`The route is a ${route.mode ?? 'mode-less'} route, and this tool reads the ${mode} broker account; give a route with mode "${mode}".`);
  if (missing(input.lookup)) throw new Error(`Give lookup: the name of one of the route's lookups (${Object.keys(objectOf(route.lookups)).join(', ') || 'it has none'}).`);
  const request = withCredentials(lookupRequest(route, input.lookup, input.query), route, heldCredentials(mode, context), { heldName: MODES[mode], now: context.now ? context.now() : Date.now() });
  const answer = await send(request.send, context.fetchImpl ?? fetch);
  if (answer.lost) return { state: 'error', http_status: null, count: 0, items: [], next: null, note: answer.lost };
  if (answer.status_code < 200 || answer.status_code >= 300) return { state: 'error', http_status: answer.status_code, count: 0, items: [], next: null, note: `the broker answered HTTP ${answer.status_code}` };
  const read = readLookupAnswer(answer, route.lookups[input.lookup]);
  return { state: 'live', http_status: answer.status_code, ...read, note: null };
}

export const placePaperOrders = (input, context) => placeOrders('paper', input, context);
export const placeLiveOrders = (input, context) => placeOrders('live', input, context);
export const checkPaperOrders = (input, context) => checkOrders('paper', input, context);
export const checkLiveOrders = (input, context) => checkOrders('live', input, context);
export const lookUpPaperInstruments = (input, context) => lookUp('paper', input, context);
export const lookUpLiveInstruments = (input, context) => lookUp('live', input, context);
