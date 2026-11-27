# tools/live-market-prices/

Reads live market prices. From public prediction markets (no account, no key): which markets are open, what each asks, its outcomes and prices (the market's own odds), volume and liquidity, and the buy and sell offers on one outcome with the best prices, the gap between them and the size on each side. From the person's own market-data account (their held key): recent price bars for the symbols they ask about and each symbol's latest close. Nothing is kept, and it never places or cancels an order (that is `tools/trading`, which takes these prices as the prices of its market orders).

## Files

| File | Purpose |
|------|---------|
| `do-work/read-market-prices.py` | The command the rows run: `markets`, `book` or `bars`. One GET built from the data row (public reads) or from the person's feed (bars, with the held fields placed where the feed says), sent with the data row's User-Agent, the reply handed to its normalizer, the normalizer's answer printed as the last line. |
| `do-work/normalize-gamma-markets.py` | Carried unchanged from the old polymarket package: the market-list reply to `{ markets, status }`. Parses the string-encoded `outcomes`, `outcomePrices` and `clobTokenIds`; a reply that is not a market list is an honest empty with the HTTP status. |
| `do-work/normalize-order-book.py` | Carried unchanged: the order-book reply to `{ book, status }`. Best bid is the highest bid price and best ask the lowest ask price (the ladder is not assumed sorted); spread, midpoint and depth are derived. |
| `do-work/normalize-price-bars.py` | From the old market-data-feed package's bar normalizer: a bars reply to `{ bars, latest, status }`, with every field name taken from the feed. |
| `sources/public-markets-api.json` | DATA: the two public addresses, paths, query names, headers, the User-Agent, the default and largest limit and which normalizer reads each reply. Another venue is another file of this shape. |
| `what-this-tool-does-and-how-to-run-it.json` | `tool:list-public-prediction-markets` and `tool:read-prediction-market-order-book` (no credential) and `tool:read-price-bars-from-my-market-data-account` (the held `market-data-credentials` on descriptor 3). All are container rows with `may_reach`. |
| `part.json` | Nothing here is imported by other code. |
| `test/normalize-gamma-markets.test.py`, `test/normalize-order-book.test.py` | The old package's 28 and 35 checks, run as scripts. |
| `test/normalize-price-bars.test.py` | 5 tests of the bars normalizer with synthetic replies. |
| `test/read-market-prices.seam.py` | 14 tests of the wrapper with a fake HTTP: requests built from the data row or the feed, User-Agent sent, held fields only in the request, 401, 403 and no-reply answers, bad requests refused. |
| `test/live-market-prices.test.mjs` | Runs the four Python files from `npm test`. |

## The feed (a run-time input for bars)

```json
{
  "url": "https://data.broker.example/v1/bars",
  "query": { "timeframe": "5Min", "limit": "120" },
  "query_names": ["symbols", "timeframe", "limit", "start"],
  "credential_injections": [{ "field": "key_id", "placement": { "kind": "header", "name": "X-Example-Key" } }],
  "bars_at": "bars",
  "fields": { "timestamp": "t", "open": "o", "high": "h", "low": "l", "close": "c", "volume": "v" }
}
```

A bars node that is an object holds one list per symbol; a list holds bars that name their symbol in `fields.symbol`. The held `market-data-credentials` is one JSON object of named text fields, such as `{ "key_id": "..." }`; a feed naming a field it lacks is refused by the field's name.

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `read_markets` | `(request, http?, source?) -> { markets, status }` | One market-list read; `limit` 1 to the data row's largest (default from the data row). |
| `read_order_book` | `(request, http?, source?) -> { book, status }` | One order-book read for `token_id`. |
| `read_price_bars` | `(request, http?, held?) -> { bars, latest, status }` | One bars read through the person's feed. |
| `status` | `{ state: "live" or "error", http_status, fetched_at, note? }` | Whether the reply was real. An error never carries invented markets, levels or bars. |

## Dependencies

**Depends on:** Python 3's standard library, the two public APIs named in `sources/public-markets-api.json`, and for bars the person's own market-data account.

**Depended on by:** `what-this-tool-does-and-how-to-run-it.json`. `tools/trading` takes `latest` as the prices of a policy's market orders, through the caller; it does not copy these reads.

## Restored from bitfield-packages `market-data-feed`

The package drew a live market feed: the instrument board (`read-data/instrument-board.ts`), the market board (`read-data/market-board.ts`), the agent cycle (`read-data/agent-cycle-surface.ts`) and the feed surface descriptor, drawn by `show/MarketDataFeedPanel.tsx`. The price pulls above (`do-work/*.py`) feed prices; these files are the screen that shows them. Moved byte for byte and not yet wired to a tool row.

| File | Purpose |
|------|---------|
| `from-bitfield-packages-market-data-feed/things-to-store-and-run.json` | Data the package carried as written. |
| `read-data/README.md` | The package's own note, moved as written. |
| `read-data/agent-cycle-surface.ts` | PURPOSE |
| `read-data/instrument-board.ts` | PURPOSE |
| `read-data/market-board.ts` | PURPOSE |
| `read-data/market-data-feed-surface.ts` | The package's code, moved as written. |
| `show/MarketDataFeedPanel.tsx` | PURPOSE |
| `show/README.md` | The package's own note, moved as written. |
| `show/mount-market-data-feed.tsx` | The package's code, moved as written. |
| `from-bitfield-packages-market-data-feed/moved-from.json` | Source path and commit of each file, identities, call rows, held tests, files that still call the retired runtime. |

Still on the retired runtime (original bytes, import paths changed): `read-data/agent-cycle-surface.ts`, `show/MarketDataFeedPanel.tsx`.
## The original package files (prepared restore)

`from-bitfield-packages/moved-from.json`: from bitfield-packages `packages/polymarket`, the Polymarket panel (`show/PolymarketPanel.tsx`, `mount-polymarket.tsx`), the readers (`read-data/polymarket-live.ts`, `polymarket-inputs.ts`) and `do-work/build-l2-auth-message.py`, the secret-free half of the order-signing request (it builds the message to sign and never emits the API secret). Not carried: `sign-poly-hmac.py`, the reference signer, which takes the secret as an argument. The order-write side of the package (CLOB `POST /order`, its connector and order-config records, and the two workflow definitions) lives only in the package boundary file, which is not carried; nothing here places an order.
