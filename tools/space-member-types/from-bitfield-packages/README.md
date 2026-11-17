# tools/space-member-types/from-bitfield-packages/

Files of the bitfield-packages package `workspace-members` at commit d926b7adb8ca24159ee64f47e7d9cae254f5b641, moved here unchanged under their own paths, so they import each other as they did. The bytes are the committed bytes of that commit, not any working tree. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into this tool's rows: wiring a file is adapting it, in a commit that names this receipt. A file that cannot load here is held: its name ends in `.held` (the same bytes). The held files import the retired Bitfield runtime (`@bitfield/runtime-kit`, `@/packages/...` and the like), vitest, or paths without a file extension; they wait for an adaptation (a calls row for the runtime import, or a port into the Workshop's own shapes). `README.original.md` is the package's own README.

| Package path | Here | Status |
|---|---|---|
| `read-data/read-workspace-members.ts` | `read-data/read-workspace-members.ts` | loads (imports only node:) |
| `show/WorkspaceMembersPanel.tsx` | `show/WorkspaceMembersPanel.tsx.held` | held: imports react, tools/ui, @bitfield/runtime-kit/react, tools/space-member-types/from-bitfield-packages/read-data/read-workspace-members.ts, ... |
| `things-to-store-and-run.json` | `things-to-store-and-run.json` | data |
