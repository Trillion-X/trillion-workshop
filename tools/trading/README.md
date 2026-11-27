# tools/trading/

Places the orders of a trading policy at the person's own broker, checks placed orders with the broker until they are
filled or closed, and looks up the instruments the broker lists (for example option contracts). Every run is either
paper or live, fixed by its row: a paper row holds only the paper account's credentials and reads and answers only paper
records, a live row only live ones, and every order and route must say the same mode. The tool decides nothing: the
policy (written by the person or their AI) names each order and its own limits, and the routes (the person's) say how
their broker takes an order. With no policy, no limits or no route, nothing is sent and the answer says what to give.

## Files

| File | Purpose |
|------|---------|
| `read-data/trading.mjs` | The runs the rows start: `placePaperOrders`, `placeLiveOrders`, `checkPaperOrders`, `checkLiveOrders`, `lookUpPaperInstruments`, `lookUpLiveInstruments`. Reads the held credentials on descriptor 4. It has no records door and keeps nothing: earlier records come in the request, the records a run would write go out in the answer. |
| `read-data/decide-orders.mjs` | `decide(...)`: checks every order of the policy and skips, with its reason, any that is malformed, of the other mode, routeless, already sent, or over a limit. Never resizes. |
| `read-data/broker-requests.mjs` | Order to request (`orderRequest`, `statusRequest`, `lookupRequest`), credentials and signed headers onto a request (`withCredentials`, `mergeHeaders`), answer to state (`readOrderAnswer`, `readLookupAnswer`). Every broker difference is route DATA. |
| `read-data/values.mjs` | Shared readers: numbers from text, dotted paths, the ASCII JSON forms an identity and a body use. |
| `read-data/account-board.ts` | `accountBoardOf({ cycle })`: the account board read from the trading agent's last cycle (hero, the account's own figures, holdings), pure; `humanLabelForSymbol` gives an option contract its label. Run by `tool:read-my-trading-account-board`. |
| `what-this-tool-does-and-how-to-run-it.json` | Seven rows: place, check and look up, each for paper and for live, and the account board read. Each row that runs `records-door`'s run-an-export or `workflows`' run-a-function packs the files it imports (workflows' host reader and large-file settings for the broker rows). |
| `test/fixtures.mjs` | A made-up broker at broker.example, its routes, synthetic policies and a fake broker. |
| `test/decide-orders.test.mjs`, `test/broker-requests.test.mjs`, `test/trading.test.mjs` | The old package's cases and the runs in process with a fake broker and no records door. |

## The policy (a run-time input)

```json
{
  "policy_version": "v1",
  "decided_at": "2026-01-01T09:00:00Z",
  "orders": [
    { "instrument": { "kind": "equity", "symbol": "BREAD" }, "side": "buy", "qty": 2, "order_type": "limit",
      "limit_price": 90, "time_in_force": "day", "live": false, "route_ref": "paper-route" }
  ],
  "risk": { "max_order_notional": 1000, "max_daily_notional": 5000, "day_time_zone": "UTC", "allowed_symbols": ["BREAD"] }
}
```

- `live` is required on every order, and must be `false` in a paper run and `true` in a live run.
- Both limits and the time zone are required; the daily limit counts the day in that zone, across runs.
- `allowed_symbols` is optional. When given, an order for any other symbol is skipped with its reason, and an empty list trades nothing. The idea is the allowed-markets limit of the MIT-licensed `bloxwap/agent-cli` (https://github.com/bloxwap/agent-cli); the code here is written fresh.
- The same order in the same `policy_version` is sent once, ever. A new set of decisions takes a new version.
- A market order (no `limit_price`) needs a price for its symbol in `prices`, to check it against the limits.

## A route (a run-time input, one per broker account)

```json
{
  "mode": "paper",
  "instrument_requests": { "equity": { "url": "https://broker.example/v1/orders", "method": "POST",
    "body_template": { "symbol": "{instrument.symbol}", "qty": "{qty}", "side": "{side}", "type": "{order_type}",
      "limit_price": { "from": "limit_price", "optional": true }, "client_order_id": "{order_id}" } } },
  "credential_injections": [{ "field": "key_id", "placement": { "kind": "header", "name": "X-Example-Key" } }],
  "response_map": { "broker_order_id": "id", "broker_status": "status", "filled_qty": "filled_qty",
    "filled_avg_price": "filled_avg_price", "filled_at": "filled_at" },
  "status_map": { "new": "submitted", "filled": "filled", "rejected": "rejected", "__default__": "submitted" },
  "status_request": { "url": "https://broker.example/v1/orders/by-client-id/{order_id}" },
  "open_statuses": ["submitted", "partially_filled"],
  "lookups": { "contracts": { "url": "https://broker.example/v1/contracts", "query": { "status": "active" },
    "items_at": "contracts", "id_field": "symbol", "keep_when": { "tradable": true }, "sort_by": { "field": "open_interest" } } }
}
```

- Template leaves: `"{path}"` (required), `{ "const": v }`, `{ "from": "path" }`, `{ "from": "path", "optional": true }`,
  `{ "from": "path", "otherwise": leaf }`. A required hole that does not resolve refuses the order before it is kept or sent.
- `body_encoding` is `json` (default) or `form`. `signed_headers` signs with `hmac-sha256` over a message template that
  can read `{request.method}`, `{request.path}`, `{request.path_and_query}`, `{request.body}` and `{now.seconds}`;
  `with_headers` carries the companion headers (such as the signed time) with the signature.
- Putting `{order_id}` into the broker's own client order id lets the broker refuse a duplicate too, and lets
  `status_request` find an order whose answer was lost.

## Held values

`paper-broker-credentials` and `live-broker-credentials`: each one JSON object of named text fields, such as
`{ "key_id": "...", "secret": "..." }`. A route names the fields it places. The value reaches only the request: it is
never in a record, an event, an answer or a log, and a route naming a field it lacks is refused by the field's name.

## Records (in the request, and in the answer)

The tool keeps nothing. Your AI reads the earlier `trade-order` and `trade-day-spend` records from the store that holds them and passes them as `records: [{ id, type, value }]` (leave it out for a first run; a check needs the orders to check). Each run answers `records`: the records it would have written, for your AI to keep. A run reads and answers only records whose id starts with its mode.

| Kind | Id | Holds |
|------|----|-------|
| `trade-order` | `<mode>-<policy_version>-<content key>` | The one record of an order: the decision, `status` (`sending`, then the broker's mapped status, `refused`, `unknown` or `not-placed`), `broker_order_id`, and the broker's real `filled_qty`, `filled_avg_price`, `filled_at`. |
| `trade-order-event` | `<order_id>-sent`, `<order_id>-checked-<ms>` | Append-only trail: the request as kept (address before any credential, header names only, body) and the broker's answer. |
| `trade-day-spend` | `<mode>-<YYYY-MM-DD>` | The notional sent that day in the policy's time zone. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `decide` | `({ mode, policy, routes, prices, existing, dayUsed }) -> { orders, skipped, policy_version }` | The checks every order passes before it may be sent. |
| `contentKey` | `(order) -> 16 hex` | The first 16 hex of the BLAKE3 identity of the order's decision fields as sorted-key JSON. |
| `orderRequest`, `statusRequest`, `lookupRequest` | `(... , route) -> { url, method, headers, body, facts, timeout_ms }` | The request a route builds. |
| `withCredentials` | `(request, route, held, { heldName, now }) -> { send, shown }` | `send` carries the held values; `shown` is what may be kept. |
| `readOrderAnswer` | `({ status_code, body }, route) -> { broker_order_id, broker_status, filled_qty, filled_avg_price, filled_at, status, http_status, ... }` | A 2xx answer read through `response_map` and `status_map`. |
| `readLookupAnswer` | `({ status_code, body }, lookup) -> { items, count, next }` | A lookup answer read through the lookup's DATA. A lookup is any read the broker answers: instruments, the positions held (a list), or the account (`one_item: true` reads the one answer object as one item, with `keep_fields` and `numbers` as for any item). Reading the account is a route lookup, not a separate tool. |

## Dependencies

**Depends on:** `tools/records-door` (the run-an-export command only; no door is opened), `tools/content-identity` (BLAKE3,
with `@noble/hashes`), Node's `fetch` and `node:crypto`.

**Depended on by:** the rows in `what-this-tool-does-and-how-to-run-it.json`. Prices for market orders come from the caller, for example from the
price-reading rows of `tools/live-market-prices`.

## Invariants

- Nothing is sent without a policy that sets both limits and the day's time zone, and a route of the run's mode.
- A 4xx answer is `refused` and gives the day's spend back; a 5xx answer or none is `unknown` and is never sent again
  once its record is handed back in `records`; only a 2xx answer is read for the broker's state.
- Fills come only from the broker's answer, never invented: a queued order reads 0 filled.
- Two runs of one mode must not place at the same moment, and a run's `records` must be kept before the next run starts:
  a run only knows the orders it is handed. A broker client order id built from `{order_id}` makes the broker refuse the
  second copy.

## Moved from bitfield-packages (byte for byte; the account board read is wired to a tool row, the screens are not yet)

The original `portfolio-connector` package: the account board read and the portfolio screen (hero, holdings, guardrails, not-connected card).

`from-bitfield-packages/moved-from.json` names each moved file, its source path, the full source commit and both identities; every file is the package's own bytes except where its entry names `calls` (a real person's name, address or home path made generic) or an adaptation (`identity_at_move`: relative imports name their file extension, `vitest` reads the shim, a package's own files import each other at their new place). 4 files moved. Files that import the shared ui parts, the screen runtime or `useBitfieldData` run in the app, not in this tree's test command; their data layer is held until it is swapped to the records door.

Tests that do not run in this tree are renamed `.held` (0); the receipt's `held` key says why for each. Every moved feature file has a port contract in `ports/from-bitfield-packages-*.json`.
