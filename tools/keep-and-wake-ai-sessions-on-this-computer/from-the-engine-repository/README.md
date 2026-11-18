# tools/keep-and-wake-ai-sessions-on-this-computer/from-the-engine-repository/

The engine's route for AI harness hook events, moved here byte for byte from trillion-rust (`src/account/hooks.rs`, `src/account/hooks.json` and `src/account/hooks/`), where it lived until the engine was cut down to its five jobs (the owner, Nov 15 2026: "anything that is not one of the five core jobs is a tool and leaves the engine"). It is not wired: the scripts in `../harness/` (`record-every-message.mjs`, `register-session.mjs`, `decisions-since.mjs`, `hook-run-receipt.mjs`) are the harness side of the same job, and the Rust route read the hook rows in `src/account/hooks.json` to run them as account operations. Adapting a file into this tool is a later commit that names the receipt.

`moved-from.json` names each file's source path and commit, the identity of its source bytes and of its bytes here. Paths under `src/` keep the engine's own layout, so `hooks.rs` still finds `hooks.json` beside it.

| File | Job |
|------|-----|
| `src/account/hooks.rs` | `HookRoutes`, the rows of `hooks.json` run for one harness event, and `command`, the part that runs on the computer the harness runs on |
| `src/account/hooks.json` | The DATA `hooks.rs` reads: the hook rows and the settings they run under |
| `src/account/hooks/executions.rs` | Bounded observations of tool executions read from a real local transcript occurrence |
| `src/account/hooks/receipt_dispatch.rs` | The hook door's protected source producer, journal-checked against the account and the exact source occurrence |
| `src/account/hooks/transcript.rs` | Reading a harness transcript from its cursor, leaving out injected parts |
| `src/account/hooks/tests.rs` | The tests of the route |
