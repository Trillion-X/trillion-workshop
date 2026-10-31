# tools/live-match-scores/

Keeps the score of a match point by point, and shows live matches. The Workshop tools `tool:score-a-match` (start a match, give a point to a side, undo the last point, type in a score, link a match to a tournament) and `tool:read-live-matches` (the scorer's view, the spectator's view and a board of schedule, bracket, standings and leaderboard), run in the tool container. Ported from the `live-match-score` package: its scoring rules, the replay of its append-only score log and the score-event builders. Nothing here is imported by the Worker.

## Files

| File | Purpose |
|------|---------|
| `read-data/scoring-rules.json` | Public scoring rules as data: tennis, pickleball and padel with a golden point. A game is one more row here (or in the `scoring_rules` of a request), never a branch in code. |
| `read-data/scoring-rules.mjs` | The phase (tiebreak or standard) and the shown score (a labelled ladder with a deuce zone, or raw counts) read from a rule's model; rule lookup by id. |
| `read-data/match-scoring.mjs` | How one point moves a match from its model: games, tiebreaks, sets and the end; the new match record from a rule. |
| `read-data/match-replay.mjs` | The log replayed: one event per sequence number, spectators without pending taps, the board rows and their fallbacks. |
| `read-data/run-as-main.mjs` | How a command runs: one JSON request on standard input, one JSON line out. |
| `do-work/score-a-match.mjs` | The command of `tool:score-a-match`: `start-match`, `score-point`, `undo-point`, `record-score`, `link-context`; each answers with records for the caller to write. |
| `do-work/read-live-matches.mjs` | The command of `tool:read-live-matches`: `{ rows, match_id? }` in, matches, board, and the next sequence number out. |
| `tool-rows.json` | The two tool rows. |
| `part.json` | No module here is offered to other tools. |
| `test/scoring-rules.test.mjs` | The rules as data: the tennis display against the longhand ladder for every score, raw counts, the tiebreak from the rule, a golden point, an invented rule, lookup. |
| `test/live-matches.test.mjs` | A match start to finish on `node:test` with made-up players: tennis through game, tiebreak, set and match; pickleball and its board rows; a golden-point game; the replay of offline taps; undo; refusals. |
| `test/live-match-rows.test.mjs` | Each row run from a folder holding only the files it packs, against its sample. |

## Key Types / Functions

| Function | Signature | Role |
|---|---|---|
| `scorePointForSide` | `(match, score, side) => score` | The score after one point, from the match's own `scoringModel`. A point after the match is won is refused. |
| `resolveDisplayScores` | `(model, pointScores, teamScores, phase) => { team-a, team-b }` | What each side shows: ladder labels with an advantage word, or raw counts. |
| `buildMatchRecord` | `(draft, rules) => match` | A new match from a rule row; the roster is checked; an unknown rule is refused. |
| `matchView` / `boardProjection` | `(state, matchId)` / `(state)` | The scorer's and spectator's views of a match; the board rows. |

## Invariants

- A scoring rule is `{ ruleId, label, scoringModel }`; the model is `scoreUnit` (`game` for a labelled ladder, `point` for rally scoring), `setsToWin`, `gamesToWinSet`, `tiebreakAt`, `pointsToWinTiebreak`, `winBy` and optionally `pointLabels` and `advantageLabel`. With an `advantageLabel` a game needs a two-point lead at the last label; without one the next point wins.
- The log only grows: an undo is a new event holding the earlier score. Two events with one sequence number count once: reconciled, then confirmed, then pending-offline; of equal state the later one.
- A spectator never sees an actor id or a tap that is still pending-offline.
- A tool keeps nothing between runs: the caller reads the match's records and writes the records an answer holds. Ids are made when not given; times come from `now` or the clock.
- Nothing here is about a person: players, rules and tournaments arrive in the request.

## Dependencies

**Depends on:** Node 24 in the tool container (`node:stream/consumers`, JSON import attributes).

**Not carried:** the old workflow-slot submission of each builder (engine plumbing the new engine does not use), the scorer and board screens, and `scoreWithDelta` (a manual plus-or-minus on the team score that no screen used; `record-score` takes a typed score instead). Behaviour changed on purpose: a rule id nobody wrote is refused (the old builder quietly used the first rule), and a point after the match is won is refused (the old code stored a repeat event).

**Depended on by:** Trillion, which reads `tool-rows.json` when it deploys.
