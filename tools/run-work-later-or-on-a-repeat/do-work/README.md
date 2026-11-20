# tools/run-work-later-or-on-a-repeat/do-work/

What other code imports from this tool.

| File | Purpose |
|------|---------|
| `timed-action.mjs` | The Rust timed-action engine (`../crates/timed-action`, built into `../built-stored-bytes/timed-action`) loaded once for a Node tool or test; every engine function re-exported. Each takes one object (shapes in `../crates/timed-action/README.md`). A browser bundle that imports the same path gets `timed-action-in-a-page.mjs` (this folder's `package.json`). |
| `timed-action-in-a-page.mjs` | The same engine for a bundle with no Node (a page, a classic-script view, a Worker): its bytes are part of the bundle and it loads synchronously. |
| `package.json` | Only its `browser` field: every browser bundle's import of `timed-action.mjs` gets `timed-action-in-a-page.mjs`. It sits here, not at the Workshop root, so it travels with any copy of `tools/` (a site's build of a Workshop export has no root package.json). |
| `quiet-hours.json` | Quiet-hours modes: DATA the engine reads at build time and the pages read to name a mode. |
| `moved-from.json` | Where the files first moved here from (Trillion-X/trillion); the TypeScript it lists was replaced by the engine and deleted. |
