# tools/run-work-later-or-on-a-repeat/from-bitfield-packages/

Files of the bitfield-packages package `timed-action` at commit d926b7adb8ca24159ee64f47e7d9cae254f5b641, moved here unchanged under their own paths, so they import each other as they did. The bytes are the committed bytes of that commit, not any working tree. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into this tool's rows: wiring a file is adapting it, in a commit that names this receipt. A file that cannot load here is held: its name ends in `.held` (the same bytes). The held files import the retired Bitfield runtime (`@bitfield/runtime-kit`, `@/packages/...` and the like), vitest, or paths without a file extension; they wait for an adaptation (a calls row for the runtime import, or a port into the Workshop's own shapes). `README.original.md` is the package's own README.

| Package path | Here | Status |
|---|---|---|
| `README.md` | `README.original.md` | data |
| `__tests__/routines-durable-owner-data.test.ts` | `__tests__/routines-durable-owner-data.test.ts.held` | held: test (vitest or the retired loader) |
| `__tests__/routines-projection.test.ts` | `__tests__/routines-projection.test.ts.held` | held: test (vitest or the retired loader) |
| `__tests__/routines-provider-icons.test.tsx` | `__tests__/routines-provider-icons.test.tsx.held` | held: test (vitest or the retired loader) |
| `__tests__/routines-surface.test.tsx` | `__tests__/routines-surface.test.tsx.held` | held: test (vitest or the retired loader) |
| `__tests__/scheduled-action-projection.test.mjs` | `__tests__/scheduled-action-projection.test.mjs.held` | held: test (vitest or the retired loader) |
| `__tests__/test-loader.mjs` | `__tests__/test-loader.mjs.held` | held: test (vitest or the retired loader) |
| `__tests__/timed-action-boundary.test.ts` | `__tests__/timed-action-boundary.test.ts.held` | held: test (vitest or the retired loader) |
| `__tests__/timed-action-ios-jscore.test.mjs` | `__tests__/timed-action-ios-jscore.test.mjs.held` | held: test (vitest or the retired loader) |
| `__tests__/timed-action-ui.test.tsx` | `__tests__/timed-action-ui.test.tsx.held` | held: test (vitest or the retired loader) |
| `__tests__/timed-action-view-model.test.ts` | `__tests__/timed-action-view-model.test.ts.held` | held: test (vitest or the retired loader) |
| `do-work/README.md` | `do-work/README.md` | data |
| `do-work/materialize-recurring-windows.test.ts` | `do-work/materialize-recurring-windows.test.ts.held` | held: test (vitest or the retired loader) |
| `do-work/process-scripts/build-process-scripts.mjs` | `do-work/process-scripts/build-process-scripts.mjs.held` | held: imports esbuild |
| `do-work/process-scripts/evaluate-due-scheduled-actions-cli.built.mjs` | `do-work/process-scripts/evaluate-due-scheduled-actions-cli.built.mjs` | loads (imports only node:) |
| `do-work/process-scripts/evaluate-due-scheduled-actions-cli.test.ts` | `do-work/process-scripts/evaluate-due-scheduled-actions-cli.test.ts.held` | held: test (vitest or the retired loader) |
| `do-work/process-scripts/evaluate-due-scheduled-actions-cli.ts` | `do-work/process-scripts/evaluate-due-scheduled-actions-cli.ts.held` | held: imports ../evaluate-due-scheduled-actions |
| `do-work/process-scripts/materialize-recurring-windows-cli.built.mjs` | `do-work/process-scripts/materialize-recurring-windows-cli.built.mjs` | loads (imports only node:) |
| `do-work/process-scripts/materialize-recurring-windows-cli.test.ts` | `do-work/process-scripts/materialize-recurring-windows-cli.test.ts.held` | held: test (vitest or the retired loader) |
| `do-work/process-scripts/materialize-recurring-windows-cli.ts` | `do-work/process-scripts/materialize-recurring-windows-cli.ts.held` | held: imports ../materialize-recurring-windows |
| `do-work/process-scripts/materialize-scheduled-action-view-cli.built.mjs` | `do-work/process-scripts/materialize-scheduled-action-view-cli.built.mjs` | loads (imports only node:) |
| `do-work/process-scripts/materialize-scheduled-action-view-cli.ts` | `do-work/process-scripts/materialize-scheduled-action-view-cli.ts.held` | held: imports ../../read-data/read-scheduled-action-graph.ts |
| `do-work/runtime-recurrence-wiring.test.mjs` | `do-work/runtime-recurrence-wiring.test.mjs.held` | held: test (vitest or the retired loader) |
| `entry-to-package-data-map.json` | `entry-to-package-data-map.json` | data |
| `read-data/README.md` | `read-data/README.md` | data |
| `read-data/read-routine-records.ts` | `read-data/read-routine-records.ts.held` | held: imports @/packages/ui |
| `read-data/read-scheduled-action-graph.ts` | `read-data/read-scheduled-action-graph.ts` | loads (imports only node:) |
| `show-ios-jscore/README.md` | `show-ios-jscore/README.md` | data |
| `show-ios-jscore/mount-timed-action-jscore.js` | `show-ios-jscore/mount-timed-action-jscore.js` | loads (imports only node:) |
| `show/README.md` | `show/README.md` | data |
| `show/RoutinesSurface.tsx` | `show/RoutinesSurface.tsx.held` | held: imports react, lucide-react, @/packages/ui, ../read-data/read-routine-records |
| `show/TimedActionSurface.tsx` | `show/TimedActionSurface.tsx.held` | held: imports react, lucide-react, ./timed-action-view-model, ./timed-action-translate, ... |
| `show/mount-timed-action.tsx` | `show/mount-timed-action.tsx.held` | held: imports react, @bitfield/runtime-kit/react, @bitfield/runtime-kit, @/packages/ui/show/react-surface-mount, ... |
| `show/timed-action-actions.ts` | `show/timed-action-actions.ts.held` | held: imports ./timed-action-view-model |
| `show/timed-action-copy.ts` | `show/timed-action-copy.ts.held` | held: imports @/packages/ui/show/status-vocabulary |
| `show/timed-action-fixtures.ts` | `show/timed-action-fixtures.ts.held` | held: imports ./timed-action-translate |
| `show/timed-action-format.ts` | `show/timed-action-format.ts.held` | held: imports ./timed-action-view-model |
| `show/timed-action-translate.ts` | `show/timed-action-translate.ts.held` | held: imports @/packages/ui/show/status-vocabulary |
| `show/timed-action-view-model.ts` | `show/timed-action-view-model.ts.held` | held: imports ./timed-action-translate, ./timed-action-copy |
| `things-to-store-and-run.json` | `things-to-store-and-run.json` | data |
