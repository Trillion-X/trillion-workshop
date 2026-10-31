# tools/tell-ais-how-to-act/

What every AI is told when it first connects, as rows. The door (trillion-rust `src/mcp/instructions.rs`) reads `rows.json` and serves it in the MCP `initialize` and `discover` instructions, in the description of its one tool, and through a paged read for what does not fit one message; it holds none of the words. A person changes what their own AIs are told with their own setting records `setting:ai-instruction:<row id>`: `false` turns a row off, `true` on, an object replaces its text, order or reach or adds a rule of their own.

## Files

| File | Purpose |
|------|---------|
| `rows.json` | The records: one `ai-instruction-settings`, the `ai-instruction-fill` records that fill `{token}`s, and the `ai-instruction` rows (id, order, text, on, reaches, needs). Its `what_this_is` says where each row came from and what was restored. |
| `do-work/read-how-ais-are-told.mjs` | `tool:read-how-ais-are-told`: lists the rows or reads one whole by id. Changes nothing. |
| `tool-rows.json` | The Workshop row Trillion reads for this folder. |
| `part.json` | Nothing here is imported by other code. |
| `test/read-how-ais-are-told.test.mjs` | Tests for this folder, run by `npm test` at the top of the repository. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `instructionRows` | `(file?) => row[]` | The `ai-instruction` rows in the order they are told. |
| `readRows` | `({ id?, file? }) => { rows, count } or { row }` | The list, or one row whole. |

## Dependencies

**Depends on:** `node:fs`.

**Depended on by:** `tool-rows.json` (`tool:read-how-ais-are-told`); the engine's door reads `rows.json` through the installed Workshop.
