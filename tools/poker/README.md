# tools/poker/

Runs a game of Texas Hold'em: opens a table, seats players, deals, takes each player's action and deals the next hand; ranks poker hands against a board; and shows a table as one player may see it. The Workshop tools `tool:run-a-poker-table`, `tool:rank-poker-hands` and `tool:view-a-poker-table-for-a-player`, run in the tool container. Ported from the `poker-rules` package (the rules) and the pure pieces of `poker-table` (betting controls, hand result); nothing here is imported by the Worker.

## Files

| File | Purpose |
|------|---------|
| `read-data/hold-em.json` | The game as data: ranks, suits, hand categories, phases, streets (cards shown, next street, next phase), betting actions, event sentences, control labels and the table settings a new table starts from. |
| `read-data/poker-rules.mjs` | The rules, pure: deck, blinds, betting round, hand evaluation, showdown, room state changes (seat, configure, start, act, next hand, kick), what one player may see, the betting controls. Every name of the game is read from `hold-em.json`. |
| `read-data/run-as-main.mjs` | How a command runs: one JSON request on standard input, one JSON line out. |
| `do-work/run-a-poker-table.mjs` | The command of `tool:run-a-poker-table`: `{ operation, room?, ... }` in, `{ result: { operation, room, ... } }` out. |
| `do-work/rank-poker-hands.mjs` | The command of `tool:rank-poker-hands`: `{ board, hands }` in, `{ result: { ranking, winners } }` out. |
| `do-work/view-a-poker-table.mjs` | The command of `tool:view-a-poker-table-for-a-player`: `{ room, player_id? }` in, the table as that player sees it out. |
| `what-this-tool-does-and-how-to-run-it.json` | The three tool rows. |
| `part.json` | No module here is offered to other tools. |
| `test/poker-rules.test.mjs` | The package's rule tests (deck, blinds, calls, config, lobby and host, street changes, showdown and split pot, all-in run-out) on `node:test` with made-up players, plus hand categories, the wheel, kickers, seeds, what a player may see and the controls. |
| `test/poker-commands.test.mjs` | The three commands over standard input: a whole hand played turn by turn with the room carried as JSON, the seed's determinism, refusals, the hidden-cards view. |
| `test/poker-rows.test.mjs` | Each row run from a folder holding only the files it packs, against its sample. |

## Key Types / Functions

| Function | Signature | Role |
|---|---|---|
| `applyRoomPlayerAction` | `(room, action, amount?) => { room, event }` | The seat to act folds, checks or calls, raises or goes all in; a finished round moves to the next street, and a showdown pays. |
| `startRoomGame` / `nextRoomHand` / `kickRoomPlayer` | `(room, random) => room` | The deals: the only functions that use a random source. |
| `seededRandom` | `(seed) => () => number` | A random source from a whole number; the same seed gives the same cards on every machine. |
| `bestHand` / `rankHands` | `(cards)` / `(board, hands)` | The best five cards and their category; hands ranked with shared places and the winners. |
| `projectRoomForPlayer` / `deriveControls` | `(room, playerId)` / `(state, playerId)` | What a player may see, and the four betting controls switched on for the seat to act only. |

## Invariants

- A tool keeps nothing between runs: the caller keeps the room (the table's saved state) and sends it back with the next operation. The room holds every player's cards, so a player is given only what `view-a-poker-table-for-a-player` returns.
- Random never comes from the clock: every deal takes a seed, and a request that deals without one is refused.
- Table objects keep the saved table's own field names (`holeCards`, `currentBet`); the tool's arguments are snake_case.
- A table keeps one pot per hand. When a player who is all in has put in less than the others, the showdown still pays the whole pot to the best hand: side pots are not worked out (the package this came from did not either).
- A table seats at most 23 players, the most a 52-card deck can deal two cards each and a board to.
- Nothing here is about a person: players, rooms and settings arrive in the request.

## Dependencies

**Depends on:** Node 24 in the tool container (`node:stream/consumers`, JSON import attributes).

**Not carried:** the old `poker-table` room descriptors, privacy-lane addresses, room-sync and engine write batches (engine plumbing the new engine does not use), the table's screen files, the workspace layout and the native-core helper (screens).

**Depended on by:** Trillion, which reads `what-this-tool-does-and-how-to-run-it.json` when it deploys.

## Moved from bitfield-packages (byte for byte, not yet wired to a tool row)

The original `poker-table` package: the table screen, the room and control request builders, the workspace layout read, the table's types and rules, and the native-core helper.

`from-bitfield-packages/moved-from.json` names each moved file, its source path, the full source commit and both identities; every file is the package's own bytes except where its entry names `calls` (a real person's name, address or home path made generic) or an adaptation (`identity_at_move`: relative imports name their file extension, `vitest` reads the shim, a package's own files import each other at their new place). 7 files moved. Files that import the shared ui parts, the screen runtime or `useBitfieldData` run in the app, not in this tree's test command; their data layer is held until it is swapped to the records door.

Tests that do not run in this tree are renamed `.held` (0); the receipt's `held` key says why for each. Every moved feature file has a port contract in `ports/from-bitfield-packages-*.json`.
## The original package files (prepared restore)

`from-bitfield-packages/moved-from.json`: `read-data/poker-rules.ts` (1,114 lines), its test, `do-work/poker-rule-requests.ts`, `show/PokerRuleSummary.tsx` and `mount-poker-rules.tsx`, byte for byte from bitfield-packages `packages/poker-rules`. `read-data/poker-rules.mjs` above is a 645-line rewrite of the rules into JavaScript with the vocabulary in `hold-em.json`; it stays because the rows run it. The TypeScript original reads its game vocabulary and state machine from the package boundary file (`things-to-store-and-run.json`), which is not carried, so it does not load here yet; its test is held.
