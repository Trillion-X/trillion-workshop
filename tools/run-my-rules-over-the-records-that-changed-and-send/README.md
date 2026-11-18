# tools/run-my-rules-over-the-records-that-changed-and-send/

Run my rules over the records that changed and send out whatever the rules call for.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | `tool:evaluate-rules-over-records`, old trillion's row (records/workshop-engine-tool-records.json at old-trillion-before-worker-retire) with its words, schemas and sample run unchanged; it now runs in a container instead of the retired Worker. |
| `do-work/run-request.mjs` | The row's entry: reads the request on stdin, runs `src/rules-over-records.mjs` over the committed trigger engine module (`tools/build-engine-modules-for-web-hosts/built-stored-bytes/trigger-engine`) with no host, and prints `{ result }` or `{ error }`. Nothing is sent: every send comes back in `fires`. |
| `src/rules-over-records.mjs` | The trigger engine as one call: rules and changed records in, `fires`, `writes` and `dispatch_failures` out (moved byte for byte). |
| `crates/trigger-engine`, `crates/trigger-engine-web` | The trigger engine (ported from bitfield-packages packages/trigger-engine) and its web module; built by `tools/build-engine-modules-for-web-hosts`. |
| `rust-src/`, `tests/` | The rule bindings and their tests, moved from trillion-rust (moved byte for byte). |
