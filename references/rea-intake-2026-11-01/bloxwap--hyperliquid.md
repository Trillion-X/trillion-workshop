# bloxwap/hyperliquid

- Source: https://github.com/bloxwap/hyperliquid @ 505178f39d99b81a17045175bf40b5421197c086 (2026-10-29). A fork of `nktkas/hyperliquid` (upstream HEAD at the time of reading: db80d598f6e4672edc090fe69994ecec97ebc980).
- Licence: MIT. Root `LICENSE` is the MIT License, and the workspace `package.json` declares `"license": "MIT"`. **Copying code into an Apache-2.0/MIT project: yes, with the MIT notice of both the fork and its upstream.**
- Why this report is separate: GitHub lists this fork among the organisation's public repositories (12 in all), but the first pass of this intake read only the 11 that are not forks. It was shallow-cloned on 2026-11-02 and only read; nothing in it was run, built, installed or imported.

## What it does
A TypeScript SDK for the Hyperliquid exchange, published as `@bloxwap/hyperliquid` (0.7.0, an early developer preview, so breaking changes are expected before 1.0). It reads market and account data, places and cancels orders, and subscribes to updates over WebSocket.

## How it is built
- A Bun workspace: `packages/hyperliquid` (the SDK, about 680 TypeScript files) and `apps/docs` (a docs site).
- `packages/hyperliquid/src/signing/` signs exchange actions. A raw private key passed as `wallet` signs with WASM secp256k1, falling back to pure JS where WASM cannot load. The README gives per-order signing times and recommends batching many orders into one `exchange.order({ orders: [...] })` call.
- Checks: Biome format and lint, a docs content check, and type-checking with tsrs (TypeScript 5 as a fallback where tsrs has no binary).

## Techniques worth learning
1. **Batching orders into one signed call.** One signature and one request cover many orders, so a bot's latency is set by the batch, not by its size.
2. **A WASM path with a pure-JS fallback** for the hot loop (signing), chosen at run time by whether WASM loads.

## Where it fits tools here
- `trading`: **not adopted.** That tool is deliberately broker-agnostic and carries no exchange SDK. A broker is a route row (`instrument_requests`, `credential_injections`, `response_map`, `status_map`), and the credential is injected at run time and never held in code. An SDK that signs with a raw private key inside the process goes against that design. Hyperliquid, if wanted, is a route row the person adds, not a dependency.
- The `allowed_symbols` limit already taken from `bloxwap/agent-cli` (MIT) covers the policy side of trading on this venue.

## Cautions
- It handles private keys in-process. That is fine for a bot the person runs themselves, but it is not a pattern for a shared tool.
- It is pre-1.0, and how far it differs from upstream is not stated anywhere. Any copy would need both MIT notices and a diff against `nktkas/hyperliquid`.
