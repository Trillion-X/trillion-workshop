# tools/organize-the-sidebar/from-bitfield-packages/

The receipt (`moved-from.json`) for what this tool took, byte for byte, from the `group` package of bitfield-packages
(`packages/group`) beyond what the old Trillion app's `tools/make-screen-layouts-and-controls` already carried here. It holds:

- 282 of the package's test files, placed under `tools/make-screen-layouts-and-controls/` the way the earlier tests are, with their imports changed to the files of this tree and `vitest` read from `test-helpers/vitest-shim.mjs`. 67 run here and pass (`.test.ts` and `.test.mjs`); 154 end in `.held`: they load `read-data/group-board-model.ts` (or another moved file) whose imports name the apps tree's layout (`../../ui/show/group/group-graph` with no file extension), which no file of this tree answers under node, or need a compiler or a browser document this repository does not carry. The reason for each is the receipt's `held` key. The 61 `.test.tsx` files are not in `npm test`'s file list and were not run.
- `show/item-add-strategies.ts` and `show/board-selection-chrome-visibility.ts`: `GroupBoardPanel.tsx` imports both and this tree held neither.
- `show/mount-group-board.tsx` and `show/mount-live-feed-board.tsx`: the generic board mounts. They read the retired package runtime (`useBitfieldData`, `@bitfield/runtime-kit/react`, the `.bitfield-entry-scope` read scope), so no tool row opens them yet; they need the records door in place of that read.

Not carried: the package's `proof/` folder (screenshots and evidence of earlier runs), `built-stored-bytes/` and `.bitfield-entry-scope/` (built output of the retired runtime), and files the package holds only as uncommitted edits (`do-work/share-reference-warnings.ts` and its test, `do-work/build-application-board-surface-contribution.test.ts`, `entry-to-package-data-map.json`; `do-work/review-share-references.ts` is deleted in the package's working tree).

`calls` swaps a real person's first name and a real business name in comments and fixtures for made-up ones; a public tree holds made-up names only.

`read-data/group-board-rows.json` (one level up, in this tool's `read-data/`) holds the 30 data rows the package's boundary file stored for the board: 18 background presets, 5 setting explanations, 3 affordance channels, 2 action affordances (ask AI, improve in place), the inspection field set and the arrangement lens catalog. No installed row held them. They are rows for the person's own lists, so they are carried as data and no code reads the file; putting them into the lists is the list-row owner's step.
Files of the bitfield-packages package `vision-board` at commit d926b7adb8ca24159ee64f47e7d9cae254f5b641, moved here unchanged under their own paths, so they import each other as they did. The bytes are the committed bytes of that commit, not any working tree. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into this tool's rows: wiring a file is adapting it, in a commit that names this receipt. A file that cannot load here is held: its name ends in `.held` (the same bytes). The held files import the retired Bitfield runtime (`@bitfield/runtime-kit`, `@/packages/...` and the like), vitest, or paths without a file extension; they wait for an adaptation (a calls row for the runtime import, or a port into the Workshop's own shapes). `README.original.md` is the package's own README.

| Package path | Here | Status |
|---|---|---|
| `README.md` | `README.original.md` | data |
| `changelog/2026-07-16-calmer-board-controls.md` | `changelog/2026-07-16-calmer-board-controls.md` | data |
| `do-work/vision-board-bytes-namespace.ts` | `do-work/vision-board-bytes-namespace.ts.held` | held: imports @/packages/cas-store/do-work/store-bytes-to-cas |
| `entry-read-scope-packages.json` | `entry-read-scope-packages.json` | data |
| `show/action-affordance-feed-shape.test.ts` | `show/action-affordance-feed-shape.test.ts.held` | held: test (vitest or the retired loader) |
| `show/action-affordance-records.test.ts` | `show/action-affordance-records.test.ts.held` | held: test (vitest or the retired loader) |
| `show/activity-input-contract.test.ts` | `show/activity-input-contract.test.ts.held` | held: test (vitest or the retired loader) |
| `show/mount-vision-board.accessibility.test.tsx` | `show/mount-vision-board.accessibility.test.tsx.held` | held: test (vitest or the retired loader) |
| `show/mount-vision-board.tsx` | `show/mount-vision-board.tsx.held` | held: imports react, tools/ui, @bitfield/runtime-kit/react, @/packages/vision-board/.bitfield-entry-scope/vision-board/runtime-kit-react, ... |
| `things-to-store-and-run.json` | `things-to-store-and-run.json` | data |
