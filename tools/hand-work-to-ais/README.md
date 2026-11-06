# tools/hand-work-to-ais/

A person's AIs hand jobs to each other through the person's own records: work is `ai-job` records and AIs are `ai` records, and every change of a job is one records:write conditioned on the value just read, so of two AIs taking one job exactly one wins. The rules of who may do what to a job, and when, are DATA (`read-data/ai-work.json`), checked by the shared stage engine in `tools/move-records-through-declared-states`.

- **One write per change, conditioned on what was read.** A take, finish, give-back or any other move writes the whole job with `expected` set to the job as it was read (the engine's own-record write, `product/own-record-writes.json`). The engine checks the condition inside the account's transaction: a job that changed meanwhile is refused whole and nothing is written. A refused take tries the next job; a refused move answers `moved: false, reason: "changed"` with the job as it now is. Nothing here locks, waits or keeps state between runs.
- **The rules are rows.** `states` (waiting, taken, done, failed, withdrawn), `transitions` ({ action, from, to, when, set, clear }), `remove_when`, `take_order` and `take_tries`. A condition is the stage engine's (`all`, `any`, `equals`, `at_least`, `at_most`, `absent`) over the signals `is_taker`, `is_sender`, `addressed_to_me`, `taken_minutes` and `terminal`; a row with no `when` holds for every AI (stuck and unstuck, so a watcher can flag a job; the note keeps who and when). `read_as` reads a stored status word as a declared state: `running`, written by other writers of long jobs, is `taken`, the one word for a job an AI is doing. The stale-take time (120 minutes as shipped) is the `taken_minutes` value of the take and release rows: change it there.
- **One current status, history in the store.** A job's `status` is its one current state. Its earlier values are the record's own version history in the person's account (the door's `history` operation), so the value keeps no second copy of past moves.
- **Same key, same job.** A job's id is `ai-job:<key>` (the request key of the run when no `key` is given), written on condition of absence: sending it again answers `already-there`. A retried run is answered the receipt the door already keeps.
- **Jobs written by others are taken the same way.** Recipe runs (`tools/workflows`, `tool:start-a-recipe-run`) write `ai-job` records with status waiting and no `to`; any AI may take them here.

## Files

| File | Purpose |
|------|---------|
| `read-data/ai-work.mjs` | `seeMyAis`, `handAJob`, `seeAiWork`, `takeAJob`, `moveAJob` (one per row), and `workRules`, `signalsOf`, `moveFor`, `movedJob`. The header states the invariant. |
| `read-data/ai-work.json` | The rules: record kinds, states, transitions, who may remove, take order and tries, read bounds, liveness default, text limits. |
| `tool-rows.json` | The five rows below. Each packs `read-data`, the stage engine file, the records-door client and its hash library, and declares only the rights its function uses. |
| `part.json` | `ai-work.mjs` and `ai-work.json` are public. |
| `test/ai-work.test.mjs` | Made-up AIs and jobs against the records door stand-in: two AIs racing for one job (exactly one wins, the loser writes nothing), two racing for the next job (they get different ones), who may finish, fail, give back, flag, withdraw and remove, the stale-take time, a move on a job that changed, the AI list and the work list, and every row run the way the container runs it. |

## Rows

| Row | Input | Answer |
|-----|-------|--------|
| `tool:see-my-ais` | `{ can?: [words], live_only? }` | `{ ais: [{ id, value, live, seen_at, busy }] }`: each AI's whole stored value (a caller names it from those cells by its own formula), live first, then the person's order |
| `tool:hand-a-job-to-an-ai` | `{ as, job, to?, priority?, outcome?, label?, key? }` | `{ job_id, status: "written" \| "already-there", job }` |
| `tool:see-ai-work` | `{ id? }` or `{ status?, to?, from?, taker?, limit? }` | `{ jobs: [job], more }`, newest first |
| `tool:take-an-ai-job` | `{ as, id?, only_mine? }` | `{ taken: job \| null, tried, job_id?, reason?, job? }` |
| `tool:change-an-ai-job` | `{ as, id, action, result?, summary?, because?, words? }`; action is take, release, finish, fail, stuck, unstuck, withdraw or remove | `{ job_id, moved, from, to, reason?, job }` |

`as`, `to`, `from` and `taker` are `ai` record ids (`ai:<name>`); a job id is `ai-job:<key>`. A job holds `status`, `job`, `to` (null: any AI), `from`, `priority`, `sent_at`, and as it moves `taker`, `taken_at`, `stuck`, `released`, `withdrawn` ({ by, at, words }), `result`, `summary`, `finished_at` and `finished_by`.

## The trillion command

`trillion who` is `tool:see-my-ais`; `send` is `tool:hand-a-job-to-an-ai`; `work [ID]` is `tool:see-ai-work`; `take [ID] [--mine]` is `tool:take-an-ai-job`; `finish ID "RESULT" [--summary]`, `release ID [--because]`, `stuck ID "WORDS" | --clear` and `withdraw ID --reason` are `tool:change-an-ai-job` with action finish, release, stuck or unstuck, and withdraw. Each runs at the person's door as `tools:run` at `@workshop-tools`.
