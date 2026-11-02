# bloxwap/smart-solana

- Source: https://github.com/bloxwap/smart-solana @ e14d1a3a92feb1836556ff1af9ffed6c84d8c401 (2026-11-01)
- Licence: MIT. Found in `LICENSE` (root, "Copyright (c) 2026 Bloxwap"), `packages/smart-solana/LICENSE` (same text), and `"license": "MIT"` in the root `package.json` and `packages/smart-solana/package.json`. `apps/docs/package.json` has no `license` field (it is the docs site, not the library). No vendored third-party code in the library source. Code may be copied into an Apache-2.0/MIT project, keeping the MIT copyright and permission notice.

## What it does

A TypeScript JSON-RPC transport for Solana that pools several RPC endpoints (by default nine keyless public mainnet providers listed in `src/registry.ts`) behind one interface usable with `@solana/kit` and, through a custom `fetch`, with legacy `@solana/web3.js` `Connection`. Each request is routed to the endpoint with the lowest adaptive score (per-method latency EWMA, tail latency, error rate, slot lag and weight), with per-endpoint token-bucket rate limits, retries with exponential backoff, a delayed "hedge" copy of slow idempotent reads, circuit breaking, honouring of `Retry-After`, in-flight request coalescing, HTTP batching, and a short per-method TTL cache with stale-while-revalidate. Before first use, each endpoint is checked against the expected cluster genesis hash and quarantined if it is on the wrong chain. It has zero runtime dependencies.

## How it is built

- Bun + Turborepo monorepo (`package.json` workspaces `apps/*`, `packages/*`; `turbo.json`; `bunfig.toml`; Biome for lint/format in `biome.jsonc`).
- `packages/smart-solana/src/` (about 1,650 lines):
  - `transport.ts` (1,004 lines): `RpcPool` class holding everything — option normalisation, endpoint selection, the retry/hedge state machine (`resilient`), per-attempt timeout and accounting (`attempt`), breaker/cooldown (`recordFailure`), genesis verification (`verify`), batching (`dispatch`, `flushBatch`), raw HTTP (`rawFetch`), activity-gated health probes (`startHealth`, `probe`), and the public `createSolanaTransport` / `smartSolana` factory.
  - `score.ts`: `MethodStat`, `observe`, `serviceMs`, `endpointScore` — the scoring maths.
  - `budget.ts`: abortable `sleep`, `TokenBucket`, `RequestBudget` (global + per-method buckets).
  - `cache.ts`: `ResponseCache`, an LRU map with expiry that reports `stale` rather than deleting.
  - `methods.ts`: method policy tables (non-retryable, rebroadcast, per-method default TTLs) and `cacheKey`.
  - `errors.ts`: `EndpointError` (status, rpcCode, retryAfterMs, retryable, rateLimited), `AllEndpointsFailedError`, `parseRetryAfter`, `redactUrl`.
  - `registry.ts`: default endpoints per cluster with rps/batch/unsupported-method notes and genesis hashes.
- Dependencies: none at runtime. `@solana/kit` / `@solana/web3.js` are what users plug it into. `apps/docs` is a Next.js + fumadocs site.
- Tests: `packages/smart-solana/tests/*.test.ts` with `bun:test`. Offline by default using an injected mock `fetch` (`tests/helpers.ts` `mockFetch`, `rpcResult`); `tests/live.test.ts` runs only when `LIVE_RPC=1`. Separate files cover budget, score, methods, registry, transport (execution, efficiency, racing/cancellation) and client integration. CI (`.github/workflows/ci.yml`) runs check, test, build on Bun 1.4.4. `.dev/bench/` holds live and sustained benchmarks.

## Reusable techniques worth learning

1. **Asymmetric EWMA latency + tail score** — `src/score.ts`. Mean latency moves faster upward than downward (alpha 0.4 up, 0.2 down); a separate "tail" EWMA jumps up fast (0.5) and decays slowly (0.05), so one slow reply is remembered. Service time is 0.6 mean + 0.4 tail, blended toward a 250 ms prior until 5 samples exist; final score multiplies by `(1 + 8 * errorRate)` and a lag penalty and divides by weight. Worth learning because it is about 50 lines, has no state beyond four numbers, and avoids both cold-start bias and flapping.
2. **Per-method stats blended with global stats** — `score.ts` `endpointScore`, `transport.ts` `recordSuccess`/`recordFailure`. Each endpoint keeps a global stat and one per method; the per-method stat takes over gradually (`min(1, samples/3)`). Good for any source that is fast for one kind of query and slow for another.
3. **Delayed hedge plus exponential-backoff retry in one state machine** — `transport.ts` `resilient`. The first attempt is launched; if it has not settled after `hedgeDelayMs` (default 300 ms) a second endpoint is tried; the first success wins and aborts the rest. On failure, retry delay is `max(soonest endpoint cooldown, retryDelayMs * 2^(n-1))`, capped at 30 s. Only idempotent methods are hedged; `sendTransaction` is never hedged.
4. **Rate-limit-aware cooldown and circuit breaker** — `transport.ts` `recordFailure`, `rawFetch`; `errors.ts` `parseRetryAfter`. A 429 (or an RPC error whose message matches "too many requests"/"rate limit") cools the endpoint for the server's `Retry-After` (seconds or HTTP-date) or `min(30 s, 1 s * 2^k)`; 401/403 cools for 60 s; N consecutive failures open the breaker for a fixed cooldown. Small and directly portable.
5. **Token-bucket budgets that refill lazily from the clock** — `budget.ts`. No timers: `refill()` computes tokens from elapsed time on each read, and `delayMs()` tells the caller exactly how long to sleep. Global plus optional per-method buckets; the clock is injectable for tests.
6. **In-flight coalescing and stale-while-revalidate cache** — `transport.ts` `execute`, `refresh`; `cache.ts`; `methods.ts`. Identical concurrent requests (key = method + JSON params) share one network promise; cached answers past their TTL are still returned immediately while one background refresh runs (deduplicated by a `refreshing` set). TTLs are per method (400 ms for `getSlot`, an hour for `getGenesisHash`).
7. **Identity check before trusting an endpoint** — `transport.ts` `verify`. Each endpoint's genesis hash is fetched once (shared promise) and compared with the expected cluster; a mismatch quarantines it permanently. The general idea — confirm a source is the thing you think it is before using its answers — transfers to any multi-source reader.
8. **Activity-gated health probes and key redaction** — `transport.ts` `startHealth` (probes only if there was traffic since the last probe; timer is `unref`'d) and `errors.ts` `redactUrl` (replaces the endpoint URL, which may contain an API key, with its label in error messages).

## Fit with trillion-workshop tools

- `tools/live-market-prices` (`do-work/read-market-prices.py`): technique 4 fits. `reply_of` currently passes `"headers": {}` to the normalizers and `urllib_http` returns only `(status, body)`, so a 429/503 reply from the public market APIs or the person's market-data account loses the provider's `Retry-After`. A small change: have the HTTP seam also return the `Retry-After` header, parse it (numeric seconds or HTTP-date, clamped to a ceiling, as `parseRetryAfter` does) and put `retry_after_seconds` in `status` (or `status.note`) when present. Pure parsing function plus a seam test with the existing fake `http` in `test/read-market-prices.seam.py`. It does not retry (the tool is one GET by design); it only reports what the provider asked for, which the caller can act on.
- `tools/keep-the-last-good-answer` (`read-data/ask-and-keep.mjs`): the same `Retry-After` reporting would fit, and the stale-while-revalidate idea is close in spirit (return the kept answer, report its age). The README says "Timeouts and retries belong to the ask", so hedging/backoff should not be added inside the primitive.
- `tools/trading`: none. It places orders, which must never be hedged or retried blindly; the repo itself excludes sends from hedging, which supports leaving trading alone.
- Endpoint pooling, scoring and hedging as a whole: none today. Workshop tools each run once and keep nothing between runs, and none reads from a pool of interchangeable endpoints, so an EWMA score has no memory to live in.

## Cautions

- The default registry names public endpoints, including a "published shared FREE key" for LeoRPC. Copying the registry would mean relying on third parties' free tiers; the README itself warns there is no SLA.
- Several defaults (method TTLs, RPC error code lists, 100-address chunking) are Solana-specific and should not be copied as general values.
- `transport.ts` is one 1,000-line class; the pure parts (`score.ts`, `budget.ts`, `cache.ts`, `parseRetryAfter`) are the easy-to-lift pieces.
- Benchmarks and provider notes in `README.md`/`apps/docs` were not verified here; nothing was run.
- Very new repository (latest commit 2026-11-01, version 0.1.0).
