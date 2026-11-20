# crates/workflow-engine

Runs the workflow engine (`workflow-core`) inside a wasm host or natively, with the host answering every step that needs the outside world.

## Files

| File | Purpose |
|------|---------|
| `Cargo.toml` | The crate: `rlib` for native tests, `cdylib` for the wasm-bindgen `web` module the Worker loads |
| `src/answer_shape.rs` | `misses(shape, answer)`: every way an answer misses the JSON Schema its step names as `submit`, each as "where: what is wrong"; a keyword it does not know is refused, never skipped |
| `src/approval.rs` | `settle(host, name, context)`: an ask of the person (`anyone`, `whoever-holds-the-run`) whose context names an `approval` (`scope`, `approver`, `credential_name`) is settled first by one statement through `tool:run-sql-in-my-database`: an `auto` setting (the scope's row, else the `*` row) answers the step and writes one `approval_decision` row; any other mode asks the person |
| `src/lib.rs` | `Host` (what the engine asks of its host), `run_definition` (native entry), the Worker entry `run`, and tests of asking in order, pausing on an unanswered ask, checks, going on once answered, and an ask its host could not reach saying so as data |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `Host` | `trait: ask(name, payload, context: Option<bytes>) -> bytes; read(from) -> bytes` | What the engine asks of its host |
| `run_definition` | `async fn(definitions, id, input, partition, product_word, host) -> Result<Value, String>` (`product_word`: the host's own word, `ProductWordIds::new` checks it) | Runs definition `id` and returns the run: `status` completed, failed or paused, and every step's output under `execution_context.steps` |
| `run` (wasm) | `async fn(definitions_json, id, input_json, partition, product_word, ask, read) -> Promise<string>` | The Worker entry; `ask(name, Uint8Array, Uint8Array?) → Promise<Uint8Array>`, `read(from) → Promise<Uint8Array>` |

An ask answered `{"$kind": "not-answered-yet", ...}` pauses the run at that step (status `paused`, the reply kept as the step's output). The host keeps the answers it gave and runs the definition again when something changes; `src/workflows.mjs` does this for every workflow.

An ask whose input names `submit` gets only an answer of that shape, whatever host gave it: `Access::ask` checks each answer with `answer_shape::misses`, and an answer that misses fails the step with `{"dispatch_failed": {"reason": "The answer to step S does not fit what it asks for: ..."}}` naming each miss. An answer of `not-answered-yet` is not checked. The host answers that step again and the run goes on.

An ask or read the host's side could not answer at all (its call failed) fails that step with `{"dispatch_failed": {"dispatch", "reason"}}` as its output (`workflow-core` `WorkflowError::evidence`), so the host can tell "could not reach it" from "it failed" and run the definition again later with the answers it kept. In the Worker, `ask` and `read` are called with `Function.prototype.call`; a host handed across a service binding must be made local functions first (`src/engine-tools.mjs` `runCompiledEngine`), since a stub would send `call` to the other side as a method name.

## Dependencies

**Depends on:** `workflow-core`, `slot-protocol`, `wasm-bindgen`, `wasm-bindgen-futures`, `js-sys` (Worker build only).

**Depended on by:** `scripts/build-worker.mjs` (builds it into `dist/workflow-engine/` through `scripts/compiled-modules.mjs`), `src/hosts/cloudflare/engines-worker.mjs` (starts it in the engines Worker, with the host made local by `src/engine-tools.mjs` `runCompiledEngine`), `src/workflow-definition-runner.mjs` (the Workshop tool `tool:run-workflow-definition` every workflow runs through), `test/workflow-engine-for-tests.mjs`, `test/workflow-engine.test.mjs`.
