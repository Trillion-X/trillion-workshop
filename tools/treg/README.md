# treg

One row calls any endpoint of treg's paid catalog by its id; finding an endpoint and reading its price are free; a call spends the person's treg balance with their saved treg key under a ceiling the caller names.

treg (https://treg.to) puts several thousand external endpoints from many providers behind one address and one token: search and SEO data, ads libraries, social posts, company data, people and company enrichment, image, video and voice generation. Its catalog is its own DATA, so this folder does not give each endpoint a row. An AI finds the endpoint for a job, reads its price and inputs, says the price to the person, and calls it by id with a cost ceiling. The balance it spends is the person's own treg balance, prepaid, which is the hard limit on any spend.

## Files

| File | Purpose |
|---|---|
| `what-this-tool-does-and-how-to-run-it.json` | Six `http` rows the engine runs (no code of their own): `tool:search-the-treg-catalog` and `tool:read-a-treg-endpoint-and-its-price` read the public catalog with no token; `tool:call-a-treg-endpoint` calls one endpoint by id; `tool:read-a-treg-call` reads one call back by its id (its cost, and an asynchronous task's progress and result); `tool:read-my-treg-team` and `tool:read-my-treg-balance` read the team's number, its balance and its recent charges. |
| `test/treg-rows.test.mjs` | Checks the rows' promises: the catalog reads carry no credential, every row that holds the token reads only the vault key the treg descriptor seals (`treg-api-key`) and places it only in the `X-Treg-Token` header, a paid call cannot be asked without a cost ceiling, the endpoint id stays inside treg's call path, and no row names a person, account or token value. And against a stand-in treg on this computer, answering as treg does: a call's cost and id are read from its answer's headers, and its asynchronous task is followed by reading the call until it settles, the call sent once. |
| `part.json` | No public files. |

## How a call is made

1. `tool:search-the-treg-catalog` `{ "job": "backlinks summary for a domain" }`: the matches, with their ids and prices.
2. `tool:read-a-treg-endpoint-and-its-price` `{ "endpoint": "<id>" }`: `endpoint.method`, `endpoint.input` (query or body fields), `endpoint.cost`, `endpoint.observed`, and `siblings` (the same job from other providers). Say the price to the person before the first call of an endpoint.
3. `tool:call-a-treg-endpoint` `{ "endpoint": "<id>", "method": "<endpoint.method>", "body": { ... } or "query": { ... }, "max_cost_usd": 0.05 }`. `max_cost_usd` is sent as treg's `X-Treg-Route-Max-Cost` header; treg refuses a call it would bill above it with HTTP 402 `route_max_cost`, before anything is charged.
4. The call's answer carries treg's reply headers beside the reply (`headers`, names in lower case): `x-treg-cost-micro` is what it cost in millionths of a US dollar (on an asynchronous submission the amount held until the task finishes), `x-treg-call-id` its id. Say the cost to the person with each answer. A 202 with `_treg.outcome: pending` is an asynchronous task (`x-treg-async` is its descriptor): treg polls the provider itself, so follow it with `tool:read-a-treg-call` `{ "call_id": "<x-treg-call-id>" }` about 60 seconds later and then every 30 to 60 seconds, until `async_task.status` is no longer `pending` (`settled` has `result_url`, which expires; `released` and `timed_out` charged nothing). Never send the call again or try another provider while it is pending.
5. `tool:read-my-treg-balance` `{ "team_id": <org_id from tool:read-my-treg-team> }`: the balance and the recent charges. What a run spent is its first balance less its last.

Failed calls (an error relayed from the provider) are not billed. An empty result is billed or not as the provider bills it; treg relays it as sent.

## The connection

The four rows that hold the token carry one credential injection `{ secret_name: "treg-api-key", placement: header X-Treg-Token }` and `may_reach: ["treg.to"]`. `treg-api-key` is the vault key the treg service connection (its descriptor in `tools/connect-a-service-and-seal-its-key/records.json`) seals the person's key under, the same way the AgentMail and AgentPhone descriptors name theirs. The engine reads that held value, places it as the request leaves over https, and replaces it wherever it appears in the reply. A row takes no account input: one person has one treg key. The value is never in the row, the input, the receipt or the answer.

A treg team key needs no team header. A person's sign-in token does: give `team` (the team slug), sent as `X-Treg-Org`.

## Dependencies

- The engine's `http` invoke kind (`src/runtime/workshop/http.rs` in the engine): the request template, the public-only network policy, the held value placed as a header, the run kept once per request key, and the reply's headers returned beside it (cookies and authorization withheld).
- treg's public API: `GET /catalog/search`, `GET /catalog/endpoints/<id>`, `GET|POST /call/<id>`, `GET /orgs/<id>/balance` (https://treg.to/integrate.md, read 2026-10-30), and `GET /auth/me` (read by the treg command line).
