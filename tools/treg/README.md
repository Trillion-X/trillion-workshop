# treg

One row calls any endpoint of treg's paid catalog by its id; finding an endpoint and reading its price are free; a call spends the person's treg balance through their treg connection under a ceiling the caller names.

treg (https://treg.to) puts several thousand external endpoints from many providers behind one address and one token: search and SEO data, ads libraries, social posts, company data, people and company enrichment, image, video and voice generation. Its catalog is its own DATA, so this folder does not give each endpoint a row. An AI finds the endpoint for a job, reads its price and inputs, says the price to the person, and calls it by id with a cost ceiling. The balance it spends is the person's own treg balance, prepaid, which is the hard limit on any spend.

## Files

| File | Purpose |
|---|---|
| `tool-rows.json` | Five `http` rows the engine runs (no code of their own): `tool:search-the-treg-catalog` and `tool:read-a-treg-endpoint-and-its-price` read the public catalog with no token; `tool:call-a-treg-endpoint` calls one endpoint by id; `tool:read-my-treg-team` and `tool:read-my-treg-balance` read the team's number, its balance and its recent charges. |
| `test/treg-rows.test.mjs` | Checks the rows' promises: the catalog reads carry no credential, every row that holds the token takes it only from a treg connection and only in the `X-Treg-Token` header, a paid call cannot be asked without a cost ceiling, the endpoint id stays inside treg's call path, and no row names a person, account or token value. |
| `part.json` | No public files. |

## How a call is made

1. `tool:search-the-treg-catalog` `{ "job": "backlinks summary for a domain" }`: the matches, with their ids and prices.
2. `tool:read-a-treg-endpoint-and-its-price` `{ "endpoint": "<id>" }`: `endpoint.method`, `endpoint.input` (query or body fields), `endpoint.cost`, `endpoint.observed`, and `siblings` (the same job from other providers). Say the price to the person before the first call of an endpoint.
3. `tool:call-a-treg-endpoint` `{ "account": "service_connection:treg", "endpoint": "<id>", "method": "<endpoint.method>", "body": { ... } or "query": { ... }, "max_cost_usd": 0.05 }`. `max_cost_usd` is sent as treg's `X-Treg-Route-Max-Cost` header; treg refuses a call it would bill above it with HTTP 402 `route_max_cost`, before anything is charged.
4. `tool:read-my-treg-balance` `{ "account": "service_connection:treg", "team_id": <org_id from tool:read-my-treg-team> }`: the balance and the recent charges. What a run spent is its first balance less its last.

Failed calls (an error relayed from the provider) are not billed. An empty result is billed or not as the provider bills it; treg relays it as sent.

## The connection

The three rows that hold the token declare `invoke.connection { vendor: "treg", from_input: "account" }` and one credential injection `{ field_id: "api_key", placement: header X-Treg-Token }`. The engine reads the value from the person's held values under the handle `service-connection-<hex of the connection id>-field-<hex of api_key>`, places it as the request leaves over https, and replaces it wherever it appears in the reply. The value is never in the row, the input, the receipt or the answer.

A treg team key needs no team header. A person's sign-in token does: give `team` (the team slug), sent as `X-Treg-Org`.

## What these rows cannot do yet

- treg answers each call's charge (`X-Treg-Cost-Micro`), its id (`X-Treg-Call-Id`), a cached answer (`X-Treg-Cache`), the provider a routed call used (`X-Treg-Served-By`) and an asynchronous task's poll descriptor (`X-Treg-Async`) in reply headers. The engine's `http` kind keeps only the status and the body, so a run reads its charges from `tool:read-my-treg-balance`, and an endpoint whose result is only reachable through the `X-Treg-Async` descriptor cannot be followed by these rows. That needs the engine's `http` kind to keep named reply headers.

## Dependencies

- The engine's `http` invoke kind (`src/runtime/workshop/http.rs` in the engine): the request template, the public-only network policy, the held value placed as a header, the run kept once per request key.
- treg's public API: `GET /catalog/search`, `GET /catalog/endpoints/<id>`, `GET|POST /call/<id>`, `GET /orgs/<id>/balance` (https://treg.to/integrate.md, read 2026-10-30), and `GET /auth/me` (read by the treg command line).
