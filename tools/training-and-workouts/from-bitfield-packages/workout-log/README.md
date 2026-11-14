# tools/training-and-workouts/from-bitfield-packages/workout-log/

The bitfield-packages workout-log package at d926b7adb8ca24159ee64f47e7d9cae254f5b641, moved here unchanged under its package paths. `moved-from.json` names each file's source path and commit and its BLAKE3 identity. Nothing here is wired into `tool-rows.json`: wiring a file is adapting it into this tool's own folders and rows, in a commit that names the receipt.

| Path | What it holds | Status |
|---|---|---|
| `things-to-store-and-run.json` | The five capture descriptors (anything, set, signal, measurement, review-correction), five projection lenses, the schema, the surface-state input and the write action | data; the runtime records (workflow action, factflow) wait for the engine's own shape |
| `read-data/workout-log.ts.held` | The full TypeScript decoder, progress chart and atom builders | held: imports the screens' timeseries chart type (`@/packages/ui`) |
| `do-work/workout-log-requests.ts.held` | Writes the whole log state through workflow action `action:workout-log:write` | held: needs `@bitfield/runtime-kit` and `slot::workflow`, which are retired |
| `show/WorkoutLogPanel.tsx.held`, `show/mount-workout-log.tsx.held` | The four-surface panel (capture, progress, review, history) | held: needs the shared UI package and the Runtime Kit |
| `read-data/workout-log.evidence-refs.test.ts.held` | Opaque evidence references are kept | held with its module |
