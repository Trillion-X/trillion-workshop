# tools/tell-ais-how-to-act/

What every AI is told when it first connects, as rows. The door (trillion-rust `src/mcp/instructions.rs`) reads `rows.json` and serves it in the MCP `initialize` and `discover` instructions, in the description of its one tool, and through a paged read for what does not fit one message; it holds none of the words. A person changes what their own AIs are told with their own setting records `setting:ai-instruction:<row id>`: `false` turns a row off, `true` on, an object replaces its text, order or reach or adds a rule of their own.

The same words can also live in the AI's own files: `tool:keep-trillion-in-your-instructions` keeps them as one marked block in a harness's global instruction file (CLAUDE.md, AGENTS.md, GEMINI.md) on the person's computer, and changes nothing else in it.

## Files

| File | Purpose |
|------|---------|
| `rows.json` | The records: one `ai-instruction-settings`, the `ai-instruction-fill` records that fill `{token}`s, and the `ai-instruction` rows (id, order, text, on, reaches, needs). Its `what_this_is` says where each row came from and what was restored. |
| `do-work/read-how-ais-are-told.mjs` | `tool:read-how-ais-are-told`: lists the rows or reads one whole by id. Changes nothing. |
| `do-work/standing-instructions.mjs` | Moved from Trillion-X/trillion `harness/standing-instructions.mjs` (record:library:rea:F-0572): keeps the standing instructions as ONE marked block in an AI harness's own global instruction file. `findBlock` (absent, found, or broken markers), `change` (the pure new text for apply or remove: every byte outside the block is kept, apply twice changes nothing), `keepInstructions({ action, harness, text?, home?, env? })` (inspect / apply / remove; writes through a symbolic link to its target beside it and renames it over, keeping its mode; a hosted app is answered with its own control). |
| `do-work/keep-standing-instructions.mjs` | `tool:keep-trillion-in-your-instructions`: `{ harness, action, text? }` on standard input, the report on standard output. The input check moved from the Mac tool `computer/harness-instructions.mjs`; its fetch of the service's words from a fixed address is left out, so a caller passes `text`. |
| `read-data/standing-instructions.json` | The block's `markers` and default `text`. |
| `read-data/harness-instruction-files.json` | Where each harness keeps its instruction file (`folder`, `home_variable`, `file`), or the control a hosted app has instead. |
| `test/standing-instructions.test.mjs` | On a pretend home: apply, twice, outdated, remove byte for byte; broken markers blocked; home variable and symbolic link; hosted apps; the entry's input check. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder: `tool:read-how-ais-are-told` and `tool:keep-trillion-in-your-instructions`. |
| `part.json` | Nothing here is imported by other code. |
| `test/read-how-ais-are-told.test.mjs` | Tests for this folder, run by `npm test` at the top of the repository. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `instructionRows` | `(file?) => row[]` | The `ai-instruction` rows in the order they are told. |
| `readRows` | `({ id?, file? }) => { rows, count } or { row }` | The list, or one row whole. |

## Dependencies

**Depends on:** `node:fs`, `node:os`, `node:path`.

**Depended on by:** `tool-rows.json` (`tool:read-how-ais-are-told`, `tool:keep-trillion-in-your-instructions`); the engine's door reads `rows.json` through the installed Workshop.
