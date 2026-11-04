# tools/show-what-a-tool-would-give-members/

Before a space owner adds a tool for members, says per member what it would give them that they do not already hold, what the tool's own descriptor says it reaches (runs on their computer, sends data off the device, can cost money, keeps results), and whether the owner has to decide it themselves. A member's gain is the operations asked minus what their grants already give them; `*` is everyone now and later. The tool version in the answer is the one handed in (the content identity of the definition), so the owner approves exactly one immutable version. What counts as a consequence is data (`src/access-impact.json`). Read-only: it grants nothing.

Moved byte for byte from Trillion-X/trillion (commit b92aa549f2) by `tools/move-code-between-trees`: `src/access-impact.mjs` and its rows `src/access-impact.json` (`moved-from.json` names each file's source and both identities). The old copy stays until its caller, Trillion's space routes (`src/person-spaces.mjs`), moves. Its old test reaches the module through that route; `test/access-impact.test.mjs` here keeps its assertions, asked of the module itself.

## Tools

| Tool | What it does | Runs |
|------|--------------|------|
| `tool:show-what-a-tool-would-give-members` | Per member gains and already-held operations, what the tool reaches, whether the owner must decide, and the words to say | in a small container, no internet |

## Files

| File | Purpose |
|------|---------|
| `src/access-impact.mjs` | `accessImpact`, `operationsOf`, `reachesOf`. |
| `src/access-impact.json` | Operations, the consequence rows and the words. |
| `test/access-impact.test.mjs` | The original assertions: gains beyond held grants, owner decisions, one member, an unknown operation. |
| `tool-rows.json` | The Workshop row. |
| `moved-from.json` | Where each moved file came from and its identities. |
| `part.json` | Public files. |
