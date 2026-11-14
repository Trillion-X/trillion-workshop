# tools/revenue-ledger/from-bitfield-packages/

Files of the bitfield-packages package `revenue-ledger` at commit d926b7adb8ca24159ee64f47e7d9cae254f5b641, moved here unchanged under their own paths, so they import each other as they did. The bytes are the committed bytes of that commit, not any working tree. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into this tool's rows: wiring a file is adapting it, in a commit that names this receipt. A file that cannot load here is held: its name ends in `.held` (the same bytes). The held files import the retired Bitfield runtime (`@bitfield/runtime-kit`, `@/packages/...` and the like), vitest, or paths without a file extension; they wait for an adaptation (a calls row for the runtime import, or a port into the Workshop's own shapes). `README.original.md` is the package's own README.

| Package path | Here | Status |
|---|---|---|
| `README.md` | `README.original.md` | data |
| `__tests__/README.md` | `__tests__/README.md` | data |
| `__tests__/read-payment-events.test.ts` | `__tests__/read-payment-events.test.ts.held` | held: test (vitest or the retired loader) |
| `__tests__/revenue-pipeline-e2e.test.ts` | `__tests__/revenue-pipeline-e2e.test.ts.held` | held: test (vitest or the retired loader) |
| `ethos-config/README.md` | `ethos-config/README.md` | data |
| `read-data/README.md` | `read-data/README.md` | data |
| `show/README.md` | `show/README.md` | data |
| `show/__tests__/present-revenue.test.ts` | `show/__tests__/present-revenue.test.ts.held` | held: test (vitest or the retired loader) |
| `show/__tests__/revenue-finance-surface.test.tsx` | `show/__tests__/revenue-finance-surface.test.tsx.held` | held: test (vitest or the retired loader) |
| `show/mount-revenue-finance.tsx` | `show/mount-revenue-finance.tsx.held` | held: imports react, @bitfield/runtime-kit/react, @/packages/ui/show/react-surface-mount, @/packages/revenue-ledger/read-data/read-payment-events, ... |
| `show/reference-grounded-screen-contract.md` | `show/reference-grounded-screen-contract.md` | data |
| `show/revenue-finance-display.ts` | `show/revenue-finance-display.ts.held` | held: imports ../read-data/revenue-types |
| `show/revenue-finance-surface.tsx` | `show/revenue-finance-surface.tsx.held` | held: imports react, lucide-react, @/packages/ui/show/card, @/packages/ui/show/container, ... |
| `things-to-store-and-run.json` | `things-to-store-and-run.json` | data |
| `vitest.config.mjs` | `vitest.config.mjs.held` | held: test (vitest or the retired loader) |
