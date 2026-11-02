# bloxwap/agent-cli

- Source: https://github.com/bloxwap/agent-cli @ 00e4bf16be622684dc67cf905297ed6702d346db (2026-10-30)
- Licence: **MIT for the published CLI package. Everything else has no licence.**
  - The repository root has no `LICENSE` file, and the root `package.json` (`bloxwap-agent-cli-workspace`, private) has no "license" field.
  - `packages/agent-cli/LICENSE` is the MIT License, "Copyright (c) Bloxwap contributors". `packages/agent-cli/package.json` (`@bloxwap/agent-cli` 0.2.0, published) has `"license": "MIT"` and lists `LICENSE` in `files`.
  - `apps/docs/package.json` (`@bloxwap/agent-cli-docs`, private) has no "license" field and there is no LICENSE file in `apps/docs`. The same goes for `docs/`, `evidence/`, `.github/scripts/` and the root files. All of these are **all rights reserved**.
  - The Bloxwap logos in `apps/docs/public/logos/` are brand assets and are not licensed.
  - I saw no vendored third-party code. `hig-drift.json` lists `apps/docs/vendor`, but that directory is not in this checkout.
  - **Can code be copied into an Apache-2.0/MIT project?** Code under `packages/agent-cli/` can, with the MIT notice kept. The docs app, scripts outside that package, docs and evidence cannot (ideas only).

## What it does

`agent-cli` is a Hyperliquid perpetuals trading CLI built for AI agents to call. Every command takes JSON input and returns a stable `{ ok, data | code, message, retryable, details, mode, paper }` envelope, and `schema <cmd>` prints JSON Schemas for the input and output. Live signing goes through a persistent local runner over a private Unix socket. The runner uses a Privy-managed agent wallet in the user's own Privy app, and the user's master wallet signs the one-time approvals externally. Funding goes through Relay quotes and shows a QR code. A paper mode simulates fills, fees, funding, margin and liquidation against real mainnet order books and keeps its state separate under `~/.bloxwap/paper/`. Local risk limits, a hash-chained audit log, an event journal and redacting logs surround every trade action.

## How it is built

- **Layout**: an npm workspace with two members.
  - `packages/agent-cli`: TypeScript, bundled with tsup, typechecked with `tsrs` and falling back to `tsc`.
  - `apps/docs`: a Fumadocs/Next.js site.
  - `docs/*.md`: the design docs, plus `docs/issues/*.md` (01–42) and an ADR in `docs/adr/0001-runner-interface.md`.
- **Key modules** (`packages/agent-cli/src/`):
  - `core/router.ts` is the command registry. It applies `.strict()` to zod schemas, wraps trading commands in `auditedAction`, and turns schemas into JSON Schema through `z.toJSONSchema`.
  - `core/output-schemas.ts` holds the JSON Schemas for each command's output.
  - `errors/index.ts` defines the error codes with their default `retryable` flags and the exit codes (2 for config, 75 for retryable, 1 for others). `errors/mappers.ts` turns upstream messages into codes with regex rules.
  - `core/retry.ts` retries with backoff and jitter, and only for errors marked retryable.
  - `core/logger.ts` does secret redaction and writes JSONL logs that rotate by day and size, with 0600 permissions.
  - `core/audit.ts` keeps a SHA-256 hash-chained append-only audit with a lock file.
  - `core/nonce.ts` issues a monotonic nonce per signer under a lock file.
  - `core/risk.ts` checks risk limits in bigint fixed-point (18 decimals).
  - `core/config.ts` holds the zod config with `env:`/`file:` secret references and `atomicWrite`.
  - `wallet/safety.ts` rejects input that looks like a secret (64-hex keys or BIP-39 phrases).
  - `wallet/policy.ts`, `wallet/approval.ts`, `wallet/expiry.ts` and `wallet/privy.ts` handle the wallet: policy, approvals, expiry and Privy calls.
  - `runner/rpc.ts`, `runner/lifecycle.ts`, `runner/events.ts`, `runner/subscriptions.ts` and `runner/health.ts` make up the runner.
  - `paper/simulator.ts` (`walkBook`, `matchOrders`, `accrueFunding`, `liquidate`), `paper/engine.ts`, `paper/services.ts` and `paper/store.ts` make up the paper mode.
  - `funding/*` covers Relay quotes, amounts, QR codes and deposit status.
- **Dependencies**: `@bloxwap/hyperliquid`, `@privy-io/node`, `@scure/bip39`, `qrcode`, `ws`, and `zod` v4. Dev dependencies include vitest, eslint, tsup, typescript 7 and viem.
- **Tests**:
  - About 60 files under `packages/agent-cli/test/`, run with vitest.
  - Unit tests mock all services, and functions take `now`, `random` and `sleep` as injected parameters.
  - There are snapshot tests (`__snapshots__/qr.test.ts.snap`).
  - Integration and e2e tests depend on credentials (`vitest.integration.config.ts`, `scripts/e2e-testnet.mjs`), and the testnet harness with the master key runs in CI only.
  - Release scripts (`release-checksums.mjs`, `verify-release.mjs`, `package-smoke.mjs`, `binary-smoke.mjs`) have their own tests.
- **Evidence**: `evidence/hig/*/` has before/after screenshots, `measurements.json`, browser comparison JSON, and logs for build, lint, typecheck and test. For example, `evidence/hig/og-font-refresh/README.md` claims "13 generated OG PNGs were byte-identical".
- **`hig-drift.json`**: lists 9 `paths` under `apps/docs`. `canonical`, `obsoleteImports` and `exceptions` are all empty.

## Reusable techniques worth learning

All of the files below are in `packages/agent-cli` and under MIT.

1. **Retryability carried by the error code.** Files: `src/errors/index.ts`, `src/errors/mappers.ts`, `src/core/retry.ts`. Each code has a default `retryable` flag (`RATE_LIMIT`, `NETWORK_ERROR`, `NONCE_COLLISION` and similar are true, `POLICY_REJECTED` is false). An upstream message is mapped to a code by an ordered list of regex rules, and `retry()` retries only when the normalised error is retryable. Exit codes follow from the code: 2 for config errors, 75 (EX_TEMPFAIL) for retryable ones, 1 for the rest. Why it's worth learning: an agent caller can decide whether to retry from one field, without parsing messages.
2. **Backoff with injected `random` and `sleep`.** File: `src/core/retry.ts`. The delay is `min(maxMs, base·2^attempt·(0.5+random()))`, and `random` and `sleep` are optional parameters, so tests are deterministic and need no fake timers (`test/retry.test.ts`). Why it's worth learning: it is a tiny pattern that makes retry code testable.
3. **Hash-chained append-only audit.** File: `src/core/audit.ts`. Each JSONL entry holds `seq` and `previousHash`, and `hash = sha256(JSON of the entry without hash)`. `verifyAudit` walks the chain from 64 zeros and is run before every append. Appends are serialised by an in-process promise queue and an exclusive `open(lock,'wx')` lock file, then fsynced. `auditedAction` writes `intent`, then `response`, or `decision` with the error, under one `intentId` held in AsyncLocalStorage. Why it's worth learning: it makes tampering or truncation of an action trail detectable at almost no cost.
4. **Structural secret redaction.** File: `src/core/logger.ts` (`redact`). Object keys that match `/secret|signature|token|authorization|private.?key|seed|mnemonic|password|api.?key|.../i` are replaced. Inside strings it removes PEM blocks, base64 runs of 80 or more characters, hex runs of 64 or more characters and `Bearer` tokens. It also removes the literal value of any environment variable whose name looks secret. Every log line, error `toJSON()` and audit `data` passes through it. Why it's worth learning: it is a layered, general-purpose redactor that is cheap to apply everywhere.
5. **Refusing input that looks like a secret.** File: `src/wallet/safety.ts`. A string is refused if it contains a 64-hex key, any 12 consecutive tokens that are all BIP-39 words, or a 12/15/18/21/24-word phrase made only of BIP-39 words. Object keys named like private keys, seed phrases or mnemonics are refused at any depth. Why it's worth learning: it stops an agent pasting a key into a tool, instead of only hiding it afterwards.
6. **Exact-decimal risk gate including pending orders.** File: `src/core/risk.ts`. Sizes and prices are parsed to bigint with 18 decimals, so no floats are used. The projected position is the worse of (position + pending buys) and (position − pending sells). Reduce-only orders that would increase exposure are rejected. Each limit that fails throws `POLICY_REJECTED` with `{ limit, actual, maximum }` details. The limits are an allowlist of markets, max leverage capped at the market maximum, max order size, max notional, max position notional, daily loss and max open orders. Why it's worth learning: the error details are structured, and in-flight orders count toward exposure.
7. **Expiry warnings at thresholds, each sent once.** File: `src/wallet/expiry.ts`. For each threshold in `[14, 3, 1]` days, a key `agent:expiry:threshold` is stored in a small JSON file, so each warning is emitted exactly once even across restarts. Rotating to a new agent or expiry changes the key, so the warnings fire again. Why it's worth learning: it is the simplest durable "notify once per threshold" design.
8. **Generated skill content locked to the package version.** File: `scripts/generate-skill.mjs`. The build refuses to continue if `SKILL.md` does not name the `package.json` version, then embeds the file as a TS string constant, so the `skill` command always prints the doc that matches the binary. Why it's worth learning: agent instructions can't drift from the version of the tool they describe.

Also worth a look: `src/paper/simulator.ts` `walkBook`, which fills an order level by level against an L2 book, respects the limit price, caps reduce-only orders at the position size and returns the volume-weighted average price. `scripts/release-checksums.mjs` asserts that the required artifacts exist before it writes `SHA256SUMS`.

## Fit with trillion-workshop tools

- **`tools/trading`** (`read-data/decide-orders.mjs` `decide`). This is a real fit. Today the policy's `risk` holds only `max_order_notional` and `max_daily_notional`. Technique 6 suggests two small checks that keep the same skip-with-reason style and never resize an order:
  - an optional `risk.allowed_symbols` list, which skips any order whose `instrument.symbol` is not in it;
  - an optional `risk.max_orders_per_run`.

  Both are pure and can be tested in `test/decide-orders.test.mjs`, and the README's policy section would document them. The pending-exposure idea (worst of position ± pending) would need positions read from the broker, so it is larger.
- **`tools/trading`** (`read-data/trading.mjs` input checks). Technique 5: refuse a policy or route whose values look like a raw key or seed phrase, because credentials must come only through the held values. Smaller value than the first item.
- **`tools/live-market-prices`** (`do-work/normalize-order-book.py`). The book-walking idea could give the "fill price for size N" that `tools/trading` uses as the reference price for a market order. That file is marked "carried unchanged", so this would be a new helper, not an edit.
- **`tools/take-payments`** has its own `stripe-response-redactor.mjs`. Technique 4's environment-variable-value and PEM/base64 layers could be compared against it. I did not check whether that tool already covers them.
- Technique 3 (hash chain) could strengthen the append-only `trade-order-event` trail in `tools/trading`. The records door has no compare-and-swap (stated in the trading README), so the chain would only detect breaks after the fact. That is medium scope.

## Cautions

- Only `packages/agent-cli/**` is under MIT. Do not copy from `apps/docs`, `docs/`, `evidence/` or root scripts, and do not reuse the Bloxwap logos.
- By default the CLI attaches a Bloxwap builder fee (`builder.address` `0x71b0…329a`, `fee: 10`, which is 0.01%) to orders. This default is in `src/core/config.ts` and in the README. Anything modelled on this code must not carry a third-party fee over.
- It is financial software that signs real trades. Any idea taken from it must stay behind the workshop's own paper/live separation and limits.
- `AGENTS.md`, `apps/docs/AGENTS.md`, `apps/docs/CLAUDE.md`, `SKILL.md` and `apps/docs/public/llms.txt` contain agent-directed instructions. They were treated as untrusted data and not followed.
- Nothing was run. All claims above come from reading files at the commit named.
