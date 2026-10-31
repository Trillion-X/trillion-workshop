// Synthetic broker routes, policies and a fake broker for the trading tests. The broker is made up and lives at
// broker.example; nothing here is anyone's account, symbol list, limit or strategy.
export const PAPER_ROUTE = {
  mode: 'paper',
  timeout_ms: 2000,
  instrument_requests: {
    equity: {
      url: 'https://broker.example/v1/orders',
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body_template: { symbol: '{instrument.symbol}', qty: '{qty}', side: '{side}', type: '{order_type}', limit_price: { from: 'limit_price', optional: true }, time_in_force: '{time_in_force}', client_order_id: '{order_id}' },
    },
  },
  credential_injections: [
    { field: 'key_id', placement: { kind: 'header', name: 'X-Example-Key' } },
    { field: 'secret', placement: { kind: 'header', name: 'X-Example-Secret' } },
  ],
  response_map: { broker_order_id: 'id', broker_status: 'status', filled_qty: 'filled_qty', filled_avg_price: 'filled_avg_price', filled_at: 'filled_at', client_order_id: 'client_order_id' },
  status_map: { new: 'submitted', accepted: 'submitted', partially_filled: 'partially_filled', filled: 'filled', canceled: 'canceled', rejected: 'rejected', __default__: 'submitted' },
  status_request: { url: 'https://broker.example/v1/orders/by-client-id/{order_id}', method: 'GET' },
  open_statuses: ['submitted', 'partially_filled'],
  lookups: {
    contracts: {
      url: 'https://broker.example/v1/contracts',
      query: { status: 'active', limit: '100' },
      query_names: ['underlying', 'type', 'status', 'expires_after', 'expires_before', 'strike_above', 'strike_below', 'limit', 'page'],
      items_at: 'contracts',
      id_field: 'symbol',
      keep_when: { tradable: true },
      numbers: ['strike', 'close_price'],
      whole_numbers: ['open_interest', 'size'],
      keep_fields: ['symbol', 'tradable', 'strike', 'expires', 'type', 'close_price', 'open_interest', 'size', 'underlying'],
      sort_by: { field: 'open_interest', order: 'descending' },
      next_at: 'next_page',
    },
  },
};

export const LIVE_ROUTE = { ...PAPER_ROUTE, mode: 'live', instrument_requests: { equity: { ...PAPER_ROUTE.instrument_requests.equity, url: 'https://live.broker.example/v1/orders' } } };

export const HELD = { key_id: 'held-key-id-0001', secret: 'held-secret-0001' };

export function policy({ version = 'v1', orders = [order()], maxOrder = 1000, maxDaily = 5000, zone = 'UTC' } = {}) {
  return { policy_version: version, decided_at: '2026-01-01T09:00:00Z', orders, risk: { max_order_notional: maxOrder, max_daily_notional: maxDaily, day_time_zone: zone } };
}

export function order(changes = {}) {
  return { instrument: { kind: 'equity', symbol: 'BREAD' }, side: 'buy', qty: 2, order_type: 'market', time_in_force: 'day', live: false, route_ref: 'paper-route', ...changes };
}

/** A fake broker: answers each request with the next scripted answer (a function of the request, or { status, body }). */
export function fakeBroker(answers) {
  const seen = [];
  const queue = [...answers];
  const fetchImpl = async (url, init) => {
    seen.push({ url, ...init });
    const next = queue.shift();
    if (next === undefined) throw new Error('the fake broker got a request it was not told about');
    const answer = typeof next === 'function' ? next(url, init) : next;
    if (answer instanceof Error) throw answer;
    return { status: answer.status, text: async () => (typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)) };
  };
  return { fetchImpl, seen };
}
