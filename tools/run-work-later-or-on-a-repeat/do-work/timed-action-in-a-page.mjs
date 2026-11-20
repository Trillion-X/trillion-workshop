// tools/run-work-later-or-on-a-repeat/do-work/timed-action-in-a-page.mjs
//
// Purpose: the Rust timed-action engine for a bundle with no Node (a page, a classic-script view, a Worker). This
// folder's package.json `browser` field answers every browser bundle's import of ./timed-action.mjs (which reads the
// bytes from disk) with this file, so a module a page and a computer share calls the same engine in both.
//
// Non-Negotiable Invariants:
//   1. This file decides nothing: it loads the engine and re-exports it.
//   2. The engine is loaded before any importer runs, synchronously: its bytes are part of the bundle (the `bytes`
//      import), so a bundle that cannot wait at the top level (a classic script) calls it the same way.

import { initSync } from '../built-stored-bytes/timed-action/timed_action.js';
import engineBytes from '../built-stored-bytes/timed-action/timed_action_bg.wasm' with { type: 'bytes' };

initSync({ module: engineBytes });

export * from '../built-stored-bytes/timed-action/timed_action.js';
