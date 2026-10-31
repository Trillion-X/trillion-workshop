// tools/trading/read-data/decide-orders.mjs
//
// The checker every order of a trading policy passes before anything reaches a broker. Pure: the policy, the
// person's routes, the prices, the orders this policy version already has and the day's spend go in; the orders to
// send and the skipped ones come out. It never sizes, rounds, clamps or picks a route. The policy's author did all of
// that, so an order that is not well formed, names no route of this run's mode, says the other mode, or would pass
// one of the policy's own limits is skipped with its reason and is never changed.
//
// Invariants:
// - Identity is the order's content: the idempotency key is the policy version and the first 16 hex of the BLAKE3
//   identity of the order's decision fields as sorted-key JSON (route_ref included), so the same order sent twice for
//   one policy version is one order, and two different orders never share a key.
// - Paper and live never mix. A run has one mode; an order's `live` must say that mode and its route must declare it.
// - Limits are the policy's, never this file's: max_order_notional per order, max_daily_notional per day with the
//   orders accepted earlier in the same run counted.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { canonicalJson, isObject, listOf, missing, numberOf, objectOf } from './values.mjs';

const given = value => (value === undefined ? null : value);

/** The first 16 hex of the identity of an order's decision fields. */
export function contentKey(order) {
  const content = {
    instrument: given(order.instrument),
    side: given(order.side),
    qty: given(order.qty),
    order_type: given(order.order_type),
    limit_price: given(order.limit_price),
    time_in_force: given(order.time_in_force),
    live: Boolean(order.live),
    route_ref: given(order.route_ref),
  };
  return makeHashCodeHexFromBytes(new TextEncoder().encode(canonicalJson(content))).slice(3, 19);
}

/** The price the prices map gives this instrument's symbol, when it is a positive number. */
function referencePrice(instrument, prices) {
  const symbol = instrument.symbol;
  if (symbol === undefined || symbol === null || !Object.hasOwn(prices, symbol)) return null;
  const price = numberOf(prices[symbol]);
  return price !== null && price > 0 ? price : null;
}

/**
 * decide({ mode, policy, routes, prices, existing, dayUsed })
 *   mode      "paper" or "live": the run's mode.
 *   policy    { policy_version, decided_at?, orders: [...], risk: { max_order_notional, max_daily_notional } }
 *   routes    { <route_ref>: route }, each route with its own `mode`.
 *   prices    { <symbol>: price }, for orders with no limit_price.
 *   existing  idempotency keys this policy version already has.
 *   dayUsed   notional already sent today.
 * -> { orders, skipped, policy_version }
 */
export function decide({ mode, policy, routes = {}, prices = {}, existing = [], dayUsed = 0 }) {
  const policyVersion = policy.policy_version;
  const risk = objectOf(policy.risk);
  const maxOrder = numberOf(risk.max_order_notional);
  const maxDaily = numberOf(risk.max_daily_notional);
  const keys = new Set(existing);
  let used = numberOf(dayUsed) ?? 0;
  const orders = [];
  const skipped = [];

  for (const raw of listOf(policy.orders)) {
    const order = objectOf(raw);
    const instrument = objectOf(order.instrument);
    const { side, route_ref: routeRef } = order;
    const contentId = contentKey(order);
    const idempotencyKey = `${policyVersion}::${contentId}`;
    const skip = reason => skipped.push({ instrument, side: given(side), reason, idempotency_key: idempotencyKey });

    if (Object.keys(instrument).length === 0) { skip('no instrument'); continue; }
    // A side must be there; which sides exist is the broker's to say.
    if (missing(side)) { skip('side missing'); continue; }
    const qty = numberOf(order.qty);
    if (qty === null || qty <= 0) { skip('qty must be a positive number the policy decides'); continue; }
    const orderType = order.order_type;
    if (missing(orderType)) { skip('order_type missing'); continue; }
    const limitPrice = numberOf(order.limit_price);
    if (orderType === 'limit' && (limitPrice === null || limitPrice <= 0)) { skip('limit order requires a positive limit_price'); continue; }
    if (typeof order.live !== 'boolean') { skip('order must say live: true or false'); continue; }
    if (order.live !== (mode === 'live')) { skip(`order says live: ${order.live}, and this run places ${mode} orders`); continue; }
    if (missing(routeRef)) { skip('order must declare route_ref'); continue; }
    const route = routes[routeRef];
    if (!isObject(route) || !Object.hasOwn(routes, routeRef)) { skip(`no route config for route_ref ${routeRef}`); continue; }
    if (route.mode !== mode) { skip(`route ${routeRef} is a ${route.mode ?? 'mode-less'} route, and this run places ${mode} orders`); continue; }
    if (keys.has(idempotencyKey)) { skip('idempotent: identical order already sent for this policy_version'); continue; }

    // The limits check the notional this file works out; an order over a limit is skipped, never made smaller.
    const reference = referencePrice(instrument, prices);
    const multiplier = numberOf(instrument.contract_multiplier) || 1;
    const priceForLimit = limitPrice ?? reference;
    if (priceForLimit === null || priceForLimit <= 0) { skip('cannot check notional against the limits without a price'); continue; }
    const notional = qty * priceForLimit * multiplier;
    if (maxOrder !== null && notional > maxOrder) { skip(`notional ${notional} exceeds policy max_order_notional ${maxOrder}`); continue; }
    if (maxDaily !== null && used + notional > maxDaily) { skip(`daily spend ${used} + ${notional} exceeds policy max_daily_notional ${maxDaily}`); continue; }

    orders.push({
      order_id: `${mode}-${policyVersion}-${contentId}`,
      mode,
      policy_version: policyVersion,
      instrument,
      side,
      qty,
      order_type: orderType,
      limit_price: limitPrice,
      time_in_force: given(order.time_in_force),
      live: order.live,
      route_ref: routeRef,
      notional,
      reference_price: reference,
      idempotency_key: idempotencyKey,
      decided_at: given(policy.decided_at),
      seq: orders.length + 1,
    });
    keys.add(idempotencyKey);
    used += notional;
  }
  return { orders, skipped, policy_version: policyVersion };
}
