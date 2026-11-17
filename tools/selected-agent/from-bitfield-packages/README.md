# tools/selected-agent/from-bitfield-packages/

Files of the bitfield-packages package `selected-agent` at commit d926b7adb8ca24159ee64f47e7d9cae254f5b641, moved here unchanged under their own paths, so they import each other as they did. The bytes are the committed bytes of that commit, not any working tree. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into this tool's rows: wiring a file is adapting it, in a commit that names this receipt. A file that cannot load here is held: its name ends in `.held` (the same bytes). The held files import the retired Bitfield runtime (`@bitfield/runtime-kit`, `@/packages/...` and the like), vitest, or paths without a file extension; they wait for an adaptation (a calls row for the runtime import, or a port into the Workshop's own shapes). `README.original.md` is the package's own README.

| Package path | Here | Status |
|---|---|---|
| `README.md` | `README.original.md` | data |
| `do-work/read-ai-readiness-target.test.ts` | `do-work/read-ai-readiness-target.test.ts.held` | held: test (vitest or the retired loader) |
| `do-work/read-ai-readiness-target.ts` | `do-work/read-ai-readiness-target.ts.held` | held: imports @bitfield/runtime-kit, ../read-data/read-runnable-ai-providers |
| `do-work/set-selected-agent.test.ts` | `do-work/set-selected-agent.test.ts.held` | held: test (vitest or the retired loader) |
| `entry-to-package-data-map.json` | `entry-to-package-data-map.json` | data |
| `read-data/read-runnable-ai-providers.test.ts` | `read-data/read-runnable-ai-providers.test.ts.held` | held: test (vitest or the retired loader) |
| `read-data/read-runnable-ai-providers.ts` | `read-data/read-runnable-ai-providers.ts` | loads (imports only node:) |
| `read-data/read-selected-agent.test.ts` | `read-data/read-selected-agent.test.ts.held` | held: test (vitest or the retired loader) |
| `read-data/read-selected-agent.ts` | `read-data/read-selected-agent.ts` | loads (imports only node:) |
| `show/AgentSelectionSurface.test.tsx` | `show/AgentSelectionSurface.test.tsx.held` | held: test (vitest or the retired loader) |
| `show/AgentSelectionSurface.tsx` | `show/AgentSelectionSurface.tsx.held` | held: imports react, @bitfield/runtime-kit/react, tools/ui, tools/selected-agent/do-work/set-selected-agent, ... |
| `show/mount-selection-surface.tsx` | `show/mount-selection-surface.tsx.held` | held: imports react, tools/ui/show/error-boundary, tools/ui/show/floating-material-frame, tools/ui/show/react-surface-mount, ... |
| `things-to-store-and-run.json` | `things-to-store-and-run.json` | data |
