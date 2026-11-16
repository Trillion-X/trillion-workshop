# tools/ai-tool-catalog/

This owner turns source definitions into callable tool rows, reads OpenAPI and MCP lists, signs in to remote tool servers, and prepares tool results with their declared effects. The original `src/live-tool-sources.mjs` imports this owner's derivation, OpenAPI and MCP functions; `src/workshop.mjs:2848-2880` manages the definitions those readers consume. `describe-the-workshop` presents already-known rows.

The account source lifecycle keeps the `accountToolSources`, `accountToolSourcesFromDoor` and `accountToolSourcesFromTask` exports, `tool:manage-my-tool-sources`, its original record address, the full `tool-source:<id>` identities and complete payloads. Edits keep `added_at`; removal keeps the deleted row. Source changes and their semantic retry receipt share one conditional records write. Source installation grants no credential, network or execution right.

The current integration is partial. Exact raw captures, the lifecycle tests and source contract now live here. The active lifecycle, validator and renamed DATA move is refused by the public-boundary reader: it cannot load `publicPathsOf`, so it cannot qualify the describe consumer's declared catalog DATA import. The active files remain at their prior paths until that shared reader is repaired; there is no copied facade here.

`ports/source-lifecycle.json` records the original source ranges and adaptation limits. The six captures in `ports/source-baselines` retain their original bytes. The exact committed configuration resolver is 4,210 bytes from `24ef640eceabfd1b979301a6c2b93739d5df228c`; the distinct 4,410-byte working snapshot remains qualified as working evidence. The native configuration owner supplies current templates/defaults and fences their witnesses at write and disclosure.

No raw baseline commit exists. The baseline-only attempt was refused, as recorded in `ports/tool-connections-raw-baseline-refusal-20261108.json` at repository root. Its paths describe that historical attempt. Published commit `4ffa1dc4a2265484f1ddf071e3dfc477e0e935f7` deleted the original source paths; the source contract preserves that observed retirement separately from incomplete baseline chronology and installed delivery.

See `do-work/README.md` and `read-data/README.md` for the existing catalog, derivation, protocol and result functions.

`from-trillion-rust/src/tool_runs/tools/effects.rs` is the engine's screen-refresh rules (what a run changes on a screen, read from a tool row's `effects`), moved whole out of trillion-rust 6cc8609d79 because that is not one of the engine's five jobs. It is not built here; `moved-from.json` names its source commit and the identity of its bytes. `read-data/declared-effects.ts` is the reader that runs.
