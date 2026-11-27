# tools/describe-the-workshop/

Describes one tool: its whole row, who made it, the sample rule of the place it runs, and the next call to make. The person's page and their AIs call `tool:describe-a-tool` through the door (`POST /work/api/door/tools:run`); the engine has no describe route of its own any more.

The source lifecycle belongs to [ai-tool-catalog](../ai-tool-catalog/README.md), which derives tools from OpenAPI descriptions. Its raw captures, contract and lifecycle tests have moved there. The active source/DATA and presentation-consumer closure move is pending the shared public-boundary reader repair; the provisional lifecycle capability row was removed. Public tool ids and lifecycle exports are preserved.

- **Moved, not rewritten.** `do-work/describe.mjs` carries trillion `src/workshop.mjs` `describeTool` (lines 1625-1655) as it was, and `read-data/workshop-sample-rules.mjs` is trillion `src/workshop-sample-rules.mjs` byte for byte. The trillion-rust engine's copy (`src/workshop_describe.rs` and the `GET /work/api/workshop/describe/<id>` route) was deleted in the same change.
- **The saved row wins.** The person's own saved row (record type `tool`, id `tool:<tool id>`, given by the caller as `saved`, read by their AI from their store; the tool reads no store), when not deleted, replaces the shared row of the same id, even when it cannot be described (paused, or a screen that is not `parts`). A saved row with no `listed_on` takes its `saved_at`.
- **Where it runs decides its samples.** The rule is DATA by the placement's executor (`read-data/workshop-sample-rules.json`); a former placement id is read as its current one (`read-data/renamed-tools.json` `placements`). The placement is the first of the tool's placements its licence class allows (every one it names when the caller gave no licence classes).
- **Source changes hold no store.** `tool:manage-my-api-descriptions` takes the account's own tool-source rows as `own` (each with the identity the store holds) and the earlier run's receipt as `receipt`, validates the add, edit or remove, and answers the rows to write as `keep`, with the version each must still be at. The caller writes them in one atomic write; the tool reads and writes nothing.
- **What it does not read.** The shared rows are the caller's (`shared`, the Workshop's `tools:list` answer). A tool's file bytes are not read (they are in its Workshop folder). The states of a saved tool's samples are kept where they ran, so each declared sample-run check is answered with `state: null`.

## Files

| File | Purpose |
|------|---------|
| `do-work/describe.mjs` | `describeATool(input)`, run by `tools/records-door/do-work/run-an-export.mjs` |
| `do-work/sources.mjs` | `accountToolSourcesFromTask(envelope)`, run by `tools/records-door/do-work/run-an-export.mjs` for `tool:manage-my-api-descriptions`: validates and shapes one source change; the caller's rows come in as `own` and the change goes back as `keep` |
| `read-data/workshop-sample-rules.mjs` | `sampleRuleOf`, `unsafeSample` |
| `read-data/workshop-sample-rules.json` | The sample rule of each executor (moved from trillion-rust `product/workshop-sample-rules.json`) |
| `read-data/renamed-tools.json` | Former tool, agent, configuration and placement ids and their current ids (moved from trillion-rust `product/renamed-tools.json`) |
| `ports/*.json` | The port contracts of the two moved modules |
| `what-this-tool-does-and-how-to-run-it.json` | The row |
| `test/describe.test.mjs` | The engine resolver's cases and trillion's sample-rule case, over made-up rows |

## Screens moved from the web client

These files were moved byte for byte from the web client (`moved-from.json` names each file's source path, commit and identity). Their imports of the web shell's files stay as written; the client build answers them with the shell's files and opens each screen as a screen module named by its row (`screen.module`).

| File | Purpose |
|------|---------|
| `web/src/workspace/workshop-screen.tsx` | Runs, Tool and Run (`tool:screen-workshop`, `tool:screen-workshop-tool`, `tool:screen-workshop-run`): every run of a tool, one tool, and one run with what it returned. |
| `show/workshop-mount.tsx` | The module entry the row names for `workshop`: `mount` is `mountWorkshopScreen`. |
| `show/workshop-tool-mount.tsx` | The module entry the row names for `workshop-tool`: `mount` is `mountWorkshopToolScreen`. |
| `show/workshop-run-mount.tsx` | The module entry the row names for `workshop-run`: `mount` is `mountWorkshopRunScreen`. |
