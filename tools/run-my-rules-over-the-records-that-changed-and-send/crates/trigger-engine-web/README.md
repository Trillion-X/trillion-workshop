# crates/trigger-engine-web/

Runs the trigger engine (`crates/trigger-engine`) over a person's own records in a wasm host: records that changed go in, each matched rule's request comes out through one host function.

## Files

| File | Purpose |
|------|---------|
| `Cargo.toml` | Crate manifest (rlib + cdylib); wasm-only `wasm-bindgen`, `js-sys`, and a `getrandom` 0.2 backend that reports entropy unavailable |
| `src/lib.rs` | Translation between host JSON and the engine's delta wire, the native `TriggerEngine`, the Worker `TriggerEngine` (wasm-bindgen), and tests |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `TriggerEngine` (Worker) | `new TriggerEngine(partition, answer)`, `apply(changesJson) → Promise<string>` | One person's engine; rules stay resident between calls |
| `TriggerEngine` (native) | `new(partition, Box<Fn(&Value) -> Result<Value, String>>)`, `apply(&Value) -> Result<Value, String>` | The same, for Rust tests and native hosts |
| change | `{address, path?, value}` or `{address, removed: true}` | A record that changed; a path naming `trigger-rule` makes it a rule |
| request (to `answer`) | `{kind:"read", address}` · `{kind:"list", cursor, limit, addresses}` · `{kind:"send", target, payload, later}` | What the engine needs from outside |
| answer | read: the record's value or null · list: `{entries:[{address, path, value}], next_cursor}` · send: the target's reply | The host's JSON reply |
| result | `{status, dispatch_failures, writes:[{address, payload}], continue}` | `writes` are durable failure and `trigger-dispatch-outcome` records to keep |
| `delta_for`, `request_for`, `Request::reply_bytes`, `outcome_json` | pure functions | The translation, shared by native and Worker |

## Invariants

- The engine is unchanged; no rule vocabulary, target or record kind is named here.
- A record's address reaches rules as `envelope.address_text` (the address text is the digest); its value as `change`.
- Content identities are BLAKE3 multihashes of the value's JSON bytes, computed here for changes and reads alike, so the engine's read-back check holds.
- A send goes to the name its rule gave; names come from the rules this engine has seen, and a send to an unknown name is refused.
- `later: true` (rule `delivery: later_with_durable_outcome`): the host keeps the request durably; the receipt is made here from the request bytes, so a rule records `accepted`, never target success.

## Building and tests

`buildCrateForAWebHost({ crate: 'trigger-engine-web', bindgenTarget: 'web' })` (`scripts/build-crate-for-a-web-host.mjs`): 4.6 MB wasm, 1.3 MB gzipped. `cargo test -p trigger-engine-web` (3 native tests); `test/trigger-engine.test.mjs` runs it from WebAssembly.

## Dependencies

**Depends on:** `trigger-engine`, `slot-protocol`, `content-crypto`, `serde_json`, `base64`, `hex`, `bytes`, `async-trait`; in a Worker `wasm-bindgen`, `wasm-bindgen-futures`, `js-sys`.

**Depended on by:** `src/tools-in-this-worker.mjs` (the Worker loads it from `dist/trigger-engine/`, built by `scripts/build-worker.mjs` from `scripts/compiled-modules.mjs`), `src/rules-over-records.mjs` (the Workshop tool `tool:evaluate-rules-over-records`, through which `src/automations.mjs` runs each person's rules), `test/trigger-engine.test.mjs`, `test/trigger-engine-for-tests.mjs`.
