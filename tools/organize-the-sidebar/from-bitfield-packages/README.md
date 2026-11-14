# tools/organize-the-sidebar/from-bitfield-packages/

The receipt (`moved-from.json`) for what this tool took, byte for byte, from the `group` package of bitfield-packages
(`packages/group`) beyond what the old Trillion app's `parts/group` already carried here. It holds:

- 282 of the package's test files, placed under `parts/group/` the way the earlier tests are, with their imports changed to the files of this tree and `vitest` read from `test-helpers/vitest-shim.mjs`. 67 run here and pass (`.test.ts` and `.test.mjs`); 154 end in `.held`: they load `read-data/group-board-model.ts` (or another moved file) whose imports name the apps tree's layout (`../../ui/show/group/group-graph` with no file extension), which no file of this tree answers under node, or need a compiler or a browser document this repository does not carry. The reason for each is the receipt's `held` key. The 61 `.test.tsx` files are not in `npm test`'s file list and were not run.
- `show/item-add-strategies.ts` and `show/board-selection-chrome-visibility.ts`: `GroupBoardPanel.tsx` imports both and this tree held neither.
- `show/mount-group-board.tsx` and `show/mount-live-feed-board.tsx`: the generic board mounts. They read the retired package runtime (`useBitfieldData`, `@bitfield/runtime-kit/react`, the `.bitfield-entry-scope` read scope), so no tool row opens them yet; they need the records door in place of that read.

Not carried: the package's `proof/` folder (screenshots and evidence of earlier runs), `built-stored-bytes/` and `.bitfield-entry-scope/` (built output of the retired runtime), and files the package holds only as uncommitted edits (`do-work/share-reference-warnings.ts` and its test, `do-work/build-application-board-surface-contribution.test.ts`, `entry-to-package-data-map.json`; `do-work/review-share-references.ts` is deleted in the package's working tree).

`calls` swaps a real person's first name and a real business name in comments and fixtures for made-up ones; a public tree holds made-up names only.

`read-data/group-board-rows.json` (one level up, in this tool's `read-data/`) holds the 30 data rows the package's boundary file stored for the board: 18 background presets, 5 setting explanations, 3 affordance channels, 2 action affordances (ask AI, improve in place), the inspection field set and the arrangement lens catalog. No installed row held them. They are rows for the person's own lists, so they are carried as data and no code reads the file; putting them into the lists is the list-row owner's step.
