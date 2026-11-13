# tools/show-my-automations-on-the-signed-in-page-what-sets/

Show my automations on the signed-in page: what sets each off and what it does, and draw a workflow or one run as a board of steps.

This folder has no row yet. Its old Trillion files are in `from-old-trillion/`: the bytes of tag `old-trillion-before-worker-retire`, under their old paths. `from-old-trillion/README.md` says which load here and which are held until what they import is here. Wiring them into a row is adapting them, in a commit that names `moved-from.json`.

## Screens moved from the web client

These files were moved byte for byte from the web client (`moved-from.json` names each file's source path, commit and identity). Their imports of the web shell's files stay as written; the client build answers them with the shell's files and opens each screen as a screen module named by its row (`screen.module`).

| File | Purpose |
|------|---------|
| `web/src/workspace/workflows-screen.tsx` | Automations and Workflow (`tool:screen-workflows`, `tool:screen-workflow`): every trigger, schedule, workflow and run with its switch, and one automation or run as a board of steps. |
| `web/src/workspace/where-words.mjs` | A where-test of a rule in plain words (only the Automations screen uses it). |
| `web/src/workspace/last-run-words.mjs` | How one automation's last run reads (only the Automations screen uses it). |
| `show/workflows-mount.tsx` | The module entry the row names for `workflows`: `mount` is `mountWorkflowsScreen`. |
| `show/workflow-mount.tsx` | The module entry the row names for `workflow`: `mount` is `mountWorkflowScreen`. |
