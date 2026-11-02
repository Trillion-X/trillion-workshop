# bloxwap/smart-hyperevm

- Source: https://github.com/bloxwap/smart-hyperevm @ 8ba025a44b896af8ffb48d91097ab1546e42cdd8 (2026-11-01)
- Licence: MIT. Found in `LICENSE` (root, "Copyright (c) 2026 Bloxwap"), `packages/smart-hyperevm/LICENSE`, and `"license": "MIT"` in the root `package.json` and `packages/smart-hyperevm/package.json`. No vendored third-party code seen in `src/`. Code may be copied into an Apache-2.0/MIT project, keeping the MIT notice.

## What it does

A TypeScript viem transport for HyperEVM (chain id 999) that pools several RPC endpoints and routes each call by an adaptive score that includes per-method latency, tail latency, errors, in-flight load and block lag. By default every idempotent read is raced on the two best endpoints at once; optional hedging, retries, a doubling-cooldown circuit breaker, token-bucket budgets, in-flight coalescing and HTTP batching sit around that. It pins `"latest"` to one block that all chosen endpoints hold so reads stay consistent across failovers, keeps a block-bounded read cache with background refresh and a rolling log index, can save learned scores between sessions ("warm start"), and pauses probes when a browser tab is hidden. A separate offline ranker (`.dev/rank.ts`, run weekly by `.github/workflows/rank-registry.yml`) probes public endpoints and writes `registry/nodes.json` with weights.

## How it is built

- Bun + Turborepo monorepo like its sibling smart-solana; library in `packages/smart-hyperevm`, Next.js/fumadocs docs in `apps/docs`.
- `src/transport/` (about 5,000 lines):
  - `mod.ts` (1,810 lines): the transport factory and the call loop (failover, race, hedge, breaker, probes, idle shutdown).
  - `_score.ts`: scoring maths (`observe`, `observeLiveness`, `serviceMs`, `inflation`, `endpointScore`) with all constants in a `ScoreConfig`.
  - `_scoreboard.ts`: per-endpoint books, head tracking with implausible-head ("liar") detection, lag penalty, adaptive `hedgeDelay`.
  - `_breaker.ts`: circuit breaker with doubling ejections and `Retry-After` extraction from nested error causes.
  - `_race.ts`: picking racers and settling on first success.
  - `_budget.ts`: lazily-refilled token buckets.
  - `_coalesce.ts`: in-flight coalescing with a stable, sorted-key, bigint-aware key.
  - `_pin.ts`: `"latest"` pinning; `_cache.ts` (929 lines): block-bounded cache and log index.
  - `_warmstart.ts`: score persistence with validation; `_activity.ts`: page-visibility gating; `_methods.ts`, `_events.ts`.
- `src/registry/`: `_policy.ts` (rank policy), `_registry.ts`, `_url.ts`. `registry/nodes.json`, `history.json`, `schema.json` are data. `.dev/probe.ts`, `rank.ts`, `sources.ts` build it.
- Dependencies: peer `viem ^2`; no other runtime dependencies.
- Tests: `tests/` with `bun test`, offline only (per `tests/README.md`), one test file per internal module (`_score.test.ts`, `_breaker.test.ts`, `race.test.ts`, `warmstart.test.ts`, …), plus registry policy/probe/source parsers and an offline simulation against viem `fallback` (`tests/bench/simulate.test.ts`). CI has `ci.yml`, a `benchmark.yml` and the weekly `rank-registry.yml`.

## Reusable techniques worth learning

1. **Load-aware score (Prequal/C3-style)** — `src/transport/_score.ts`. Same asymmetric mean/tail EWMA as smart-solana, but the service estimate is multiplied by `inflation(inflight) = 1 + q + 0.25*q^2`, so an endpoint already carrying requests looks proportionally slower, and the constants live in one config object. `observeLiveness` lets a health probe cool the error rate without teaching the latency average (a probe is not a real call). Worth learning as a well-commented, tunable version of the idea.
2. **Circuit breaker with doubling ejections and probe/call separation** — `_breaker.ts`. Three consecutive failures eject an endpoint for 5 s, doubling each ejection up to 60 s; a `Retry-After` ejects at once for the time asked (clamped to the ceiling). A successful health probe does not close a circuit opened by real call failures, because "a node can answer `eth_blockNumber` while it hangs every read". `retryAfterMs` walks up to four levels of `error.cause` to find response headers. Small, pure (clock injected), and well tested.
3. **Adaptive hedge delay** — `_scoreboard.ts` `hedgeDelay`. Instead of a fixed delay, hedge after `max(minDelay, tail * multiplier)` once an endpoint has 3+ samples. This means a copy is sent only when the call is slow relative to that endpoint's own recent tail.
4. **Racing without cancelling the losers** — `_race.ts`. Idempotent reads go to the top N endpoints; the first success wins, but losers are allowed to finish so their latency is still measured and scores keep tracking reality. A failure only ends the race early if it is "decisive" (e.g. a revert every endpoint would return).
5. **Median-of-peers sanity check on reported heads** — `_scoreboard.ts` `#heads`. An endpoint whose head leads the median of the others by more than `maxAhead` is ignored as implausible; with exactly two disagreeing heads, no reference is believed until a third arrives. Prevents one broken source from making every honest source look behind. Transferable to any "latest value" read from several sources.
6. **Warm start from untrusted storage** — `_warmstart.ts`. Saved scores are treated as a prior, not a measurement: a restored book counts as at most 2 samples, values are clamped to the per-attempt deadline, snapshots are size-capped (256 KiB), age-limited (1 h, with 60 s clock-skew tolerance), method names regex-checked, and `__proto__` handled via `Object.getOwnPropertyDescriptor`. Saves wait until the load has settled so a fresh instance cannot overwrite data it has not read. Good model for "remember something between runs safely".
7. **Stable coalescing key** — `_coalesce.ts` `coalesceKey`. Serialises params with sorted object keys, tags bigints, keeps NaN/Infinity distinct from null, and refuses (returns undefined) on cycles, so two logically equal requests share one key and unequal ones never collide.
8. **Probation weights for new sources** — `src/registry/_policy.ts`. Over a 28-day window, a new endpoint is capped at weight 0.15 until it has 3 successful probes spread over 14 days at 80% uptime, and all new endpoints together may hold at most 25% of total weight. A simple, explainable admission policy for any list of third-party sources.

## Fit with trillion-workshop tools

- `tools/keep-the-last-good-answer` (`read-data/ask-and-keep.mjs`): technique 2's `Retry-After` reading fits. Today `bodyOf` throws `the address answered <status>` and the kept answer is returned, but a 429/503 `Retry-After` from the source is dropped. Small change: when the reply is not OK and carries `Retry-After`, parse it (numeric seconds incl. decimals, or HTTP-date, clamped, as `parseRetryAfter` in `_breaker.ts` does), and return `retry_after_seconds` in the result and in `said` ("the address asked to wait N seconds"). The existing loopback test server in `test/ask-and-keep.test.mjs` already answers chosen statuses, so this is testable by adding a header. It does not add retries, which the README reserves for the ask.
- `tools/keep-the-last-good-answer` (primitive): technique 6 is a useful checklist for reading a kept record back (validate shape, clamp, bound age), but the tool already treats an unreadable kept answer as none, so no change is needed.
- `tools/live-market-prices`: same `Retry-After` reporting as noted in the smart-solana report; one implementation would serve both.
- Pool scoring, racing, pinning, the block cache: none. Workshop tools run once and do not hold a pool of interchangeable endpoints or state between runs.

## Cautions

- Large and dense: `mod.ts` is 1,810 lines and `_cache.ts` 929; the pure helpers are the parts worth lifting, not the transport.
- Much of the logic is HyperEVM-specific (instant finality, ~1 block/s, HyperCore precompile range `0x…0800`–`0x…08ff`, 1,000-block log cap). The cache's correctness argument relies on "no reorgs", which does not hold on most chains.
- Racing by default doubles upstream traffic for reads; the README says so.
- `registry/nodes.json` lists third-party public endpoints with probe history; not verified here, nothing was run.
- Last commit is a breaking rename (`feat!: rename transport to smartHyperevm`); API is young.
