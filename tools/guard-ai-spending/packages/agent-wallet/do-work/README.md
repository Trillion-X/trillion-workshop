# agent-wallet/do-work

Pure decision/computation scripts (Node ESM) that the rail-agnostic spend workflows run as `compute.process` steps — the engine has no branch step and no arithmetic binding ops, so all numeric/conditional spend logic lives here as side-effect-free functions over self-describing inputs.

## Files

| File | Purpose |
|------|---------|
| `decide-budget.mjs` | The spend-gate reducer. Reads wallet config + request + existing reservation, decides approve/deny against status/enabled/daily_limit/auto_approve_threshold, emits `budget_check` + `budget_reservation`. Fail-closed; idempotent on an existing current reservation. |
| `decide-daily-reset.mjs` | UTC-day roll-over gate. Exit 0 = reset (day changed), exit 3 = same-day no-op. Single-flight via the last-reset marker. |
| `record-spend.mjs` | Post-payment ledger increment. Adds a confirmed spend amount to `total_spent_today` + `total_spent_all_time` and emits a `payment_processed` audit record. |
| `build-eip712-digest.mjs` | The generic EIP-712 digest builder (PUBLIC half of the two-step signing split — no key, no network). Takes an EIP-712 typed-data document (`{domain, types, primaryType, message}`) as DATA and emits the 32-byte keccak signing digest. Serves x402 ERC-3009 `TransferWithAuthorization` AND Polymarket V2 `Order` with zero code change (new venue = new DATA descriptor). Self-contained keccak-256 (no npm deps); a startup KAT self-test fails loud on any transcription bug. |

## Key Functions

| Function (file) | Signature / Shape | Role |
|-----------------|-------------------|------|
| `main()` (decide-budget) | argv[2]=out, argv[3..7]=wallet status/enabled/daily_limit/auto_approve_threshold/total_spent_today value_json, argv[8]=request JSON, argv[9]=now ISO, argv[10]=existing reservation JSON → writes decision JSON to out + stdout | Spend authorization. Output: `{approved, reason, idempotent, budget_check, budget_reservation, spend_snapshot}`. Exit 0 = well-formed decision (approve OR deny); non-zero = malformed input only. |
| `main()` (decide-daily-reset) | argv[2]=last-reset marker JSON → stdout `{should_reset, now_iso, day}`; exit 0/3/2 | UTC-day roll-over decision (edges gate on exit_code). |
| `main()` (record-spend) | argv[2]=out, argv[3]=total_spent_today value_json, argv[4]=total_spent_all_time value_json, argv[5]=spend JSON, argv[6]=now ISO → ledger JSON | Spend total increment + payment record. |
| `parseFactValue(raw)` | `string → any \| undefined` | Decodes a read-current `value_json` (JSON-encoded scalar); empty/absent → undefined → caller's fail-closed default. |
| `asInt` / `asBool` / `asString` | `(value, fallback) → T` | Tolerant scalar coercion (integer minor units of USD throughout). |
| `main()` (build-eip712-digest) | argv[2]=out, argv[3]=typed-data JSON `{domain,types,primaryType,message}` → writes `{ok, digest_hex, digest_b64, domain_separator_hex, struct_hash_hex, primary_type}` to out + stdout | EIP-712 digest construction. `digest_b64` (32-byte STANDARD base64) feeds straight into the credentials-vault `sign` op's `message_b64` with `scheme:"secp256k1"`. Exit 2 on bad input or a failed crypto self-test (never emits a wrong digest). |
| `keccak256(bytes)` / `eip712Digest(doc)` (build-eip712-digest) | `Uint8Array → Uint8Array(32)` / `doc → {digest, domainSeparator, structHash}` | Inlined keccak-256 (FIPS-202 Keccak-f[1600], Ethereum 0x01 pad-domain) + the EIP-712 `keccak256(0x1901 ‖ domainSeparator ‖ hashStruct)` encoder. Rho/pi constants derived from the spec recurrence (zero hand-copied tables). |

## Invariants

- Integer minor units of USD (cents) — no float drift.
- Wallet values arrive as `engine.operation.read-current` `value_json` (live-log facts are read by address, NOT `find-current-items`, which only sees the package-admission projection).
- No closed enums: wallet status, decision result, reservation status are opaque strings passed through.
- Fail-closed for money: absent/disabled/non-active wallet → DENY every positive-cost request. A validated zero-cost request still receives a check and zero-amount fence without consuming payment-wallet authority.

## Dependencies

**Depends on:** Node `node:fs` (+ `node:crypto` is NOT used — keccak-256 is inlined in `build-eip712-digest.mjs`, so the digest builder has zero external packages and needs no `@noble/*` install). All scripts are zero-external-dependency by design (they run sandboxed under `compute.process`).
**Depended on by:** the canonical workflow definitions (`action:budget-gate`, `action:reset-daily-spend`, `action:record-spend`) and any rail-specific signing/settlement blob named by a `payment-rail-descriptor` — all via `package::agent-wallet::stored-bytes::<name>` blob mounts.
