# tools/show-my-automations-on-the-signed-in-page-what-sets/

Show my automations on the signed-in page: what sets each off and what it does, and draw a workflow or one run as a board of steps.

The screens below were moved from the web client and read `/work/api/workflows`, a route the engine does not answer (the native app repository's `macos/route-owner-port.md`, line 206: "not ported (#212)"). What those reads showed is now answered by `tool:list-my-automations`, from the engine's own sources: the rows `wake:list` answers (`tool:see-what-runs-on-its-own` says their words and states) and the person's workflow rows. The old rules and schedules store (`when.recorded`, `every.unit`, hand-offs to an AI) is not the engine's any more: it wakes only on facts and kept-running programs. The old `src/work-workflows.mjs` is not in this repository: its bytes are in the parked copy of old code, under `tools/show-my-automations-on-the-signed-in-page-what-sets/from-an-older-version/`.

## The read (`tool:list-my-automations`)

| File | Purpose |
|------|---------|
| `do-work/list-my-automations.mjs` | `listMyAutomations({ wakes, recipes?, tools?, open? })`: one row per wake (a trigger, a schedule or a kept-running program) with what sets it off in plain words, what it does, its state and last run, and its switch; one row per workflow with the words of the conditions it fires on; with `open`, one automation or workflow as a when-then graph with the input schema of what it runs. It imports `seeWhatRunsOnItsOwn` from `tools/what-runs-on-its-own`, so the words are one set. Reads only. |
| `read-data/record-kind-words.json`, `read-data/record-kind-words.mjs` | What sets a trigger off for a kind of fact, as the end of "When ...": the kind's own words, else "a <kind> is recorded". Moved byte for byte from the old repository (commit `5dc302be37`); adding a kind's words is one row. |
| `test/list-my-automations.test.mjs` | The assertions of the old `test/work-workflows-edits.test.mjs` that still describe the job (a trigger as what sets it off then what it does, the input schema of what it runs), the kind words, schedules, kept-running programs, a failed run red first, a workflow row with its fields as JSON text, and the program run as the tool container runs it. |

## Screens moved from the web client

These files were moved byte for byte from the web client (`moved-from.json` names each file's source path, commit and identity). Their imports of the web shell's files stay as written; the client build answers them with the shell's files and opens each screen as a screen module named by its row (`screen.module`).

| File | Purpose |
|------|---------|
| `web/src/workspace/workflows-screen.tsx` | Automations and Workflow (`tool:screen-workflows`, `tool:screen-workflow`): every trigger, schedule, workflow and run with its switch, and one automation or run as a board of steps. |
| `web/src/workspace/where-words.mjs` | A where-test of a rule in plain words (only the Automations screen uses it). |
| `web/src/workspace/last-run-words.mjs` | How one automation's last run reads (only the Automations screen uses it). |
| `show/workflows-mount.tsx` | The module entry the row names for `workflows`: `mount` is `mountWorkflowsScreen`. |
| `show/workflow-mount.tsx` | The module entry the row names for `workflow`: `mount` is `mountWorkflowScreen`. |
