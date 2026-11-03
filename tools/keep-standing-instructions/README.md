# tools/keep-standing-instructions/

Keeps Trillion's standing instructions as one marked block in the instruction file an AI harness reads at the start of every conversation (Claude Code `CLAUDE.md`, Codex `AGENTS.md`, Gemini CLI `GEMINI.md`). It runs on the person's own computer as a `computer` row holding one capability, `change-a-folder`: the person grants it their AI's own folder (`~/.claude`, `~/.codex`, `~/.gemini`, or wherever they moved it), and the run reaches that folder and nothing else. inspect reads, apply writes or replaces only the block, remove deletes only the block; every other byte of the file stays as it was, and apply twice changes nothing. A hosted app with no file (ChatGPT, Claude, Gemini, Grok, Cursor, Hermes, Muse) is answered with the control it has and nothing is written.

Moved here from `Trillion-X/trillion` `computer/harness-instructions.mjs` (tool:keep-trillion-in-your-instructions on the Mac tool host) and `harness/standing-instructions.mjs` with `harness/standing-instructions.json` (2026-11-03). What the move dropped: the fetch of the service's published copy of the words (`/workspace/harness/standing-instructions.json`); the engine keeps the installed Workshop current, so this folder's copy is the current one. The harness's home variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`): the folder the person grants is the harness's folder.

## Files

| File | Purpose |
|------|---------|
| `read-data/standing-instructions.mjs` | `keep` (the row's export, `{ input: { harness, action }, folder }`), `keepInstructions` (the file work), and the pure helpers `blockOf`, `findBlock`, `change`. |
| `read-data/standing-instructions.json` | The markers, the words, and where each harness keeps its instructions (copied from the engine's `product/harnesses.json` `standing_instructions`). |
| `tool-rows.json` | `tool:keep-trillion-in-your-instructions`: a `computer` row with `capabilities: ["change-a-folder"]`, the granted folder filled into its standard input. |
| `part.json` | Nothing here is imported by other code. |
| `test/standing-instructions.test.mjs` | A pretend harness folder: apply, inspect, update, remove, damaged markers, a hosted app, refused input, the row. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `keep` | `({ input: { harness, action }, folder }) => { schema, observed_at, text_from, report }` | The tool. Refuses any other input field, an unknown harness or action. |
| `keepInstructions` | `({ action, harness, folder, text? }) => report` | `status` absent, present, outdated, blocked or use-host-control; `changed`; `path`. |
| `change` | `(content, action, block?) => { state, next }` | The new file text; every byte outside the block is untouched. |

## Dependencies

**Depends on:** Node's standard library; `tools/records-door` (`run-an-export.mjs`) for a `computer` run.

**Depended on by:** `tool-rows.json`; `tools/tell-ais-how-to-act/rows.json` tells every AI to run `tool:keep-{word}-in-your-instructions` on connect.
