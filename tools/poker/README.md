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
| `tool-rows.json` | The three tool rows. |
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

**Depended on by:** Trillion, which reads `tool-rows.json` when it deploys.
