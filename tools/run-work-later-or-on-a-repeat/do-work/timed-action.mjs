// tools/run-work-later-or-on-a-repeat/do-work/timed-action.mjs
//
// Purpose: the Rust timed-action engine (../crates/timed-action, built into ../built-stored-bytes/timed-action) loaded
// once for a Node tool or test, and every engine function handed out as it is. Each function takes one object (the
// request shapes are in ../crates/timed-action/README.md) and answers a plain value; a refusal is thrown with the
// engine's words. A browser bundle (a page, a classic-script view, a Worker) gets ./timed-action-in-a-page.mjs instead:
// this folder's package.json `browser` field says so, and it travels with any copy of tools/.
//
// Non-Negotiable Invariants:
//   1. This file decides nothing: it loads the engine and re-exports it.
//   2. The engine is loaded before any function is handed out, so no caller answers without it.

import { readFileSync } from 'node:fs';
import { initSync } from '../built-stored-bytes/timed-action/timed_action.js';

initSync({ module: readFileSync(new URL('../built-stored-bytes/timed-action/timed_action_bg.wasm', import.meta.url)) });

export * from '../built-stored-bytes/timed-action/timed_action.js';
