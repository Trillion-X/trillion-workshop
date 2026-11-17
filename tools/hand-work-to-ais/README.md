# tools/hand-work-to-ais/

A person's AIs hand jobs to each other through the person's own records: work is `ai-job` records and AIs are `ai` records, and every change of a job is one records:write conditioned on the value just read, so of two AIs taking one job exactly one wins. The rules of who may do what to a job, and when, are DATA (`read-data/ai-work.json`), checked by the shared stage engine in `tools/move-records-through-declared-states`.

- **One write per change, conditioned on what was read.** A take, finish, give-back or any other move writes the whole job with `expected` set to the job as it was read (the engine's own-record write, `product/own-record-writes.json`). The engine checks the condition inside the account's transaction: a job that changed meanwhile is refused whole and nothing is written. A refused take tries the next job; a refused move answers `moved: false, reason: "changed"` with the job as it now is. Nothing here locks, waits or keeps state between runs.
- **The rules are rows.** `states` (waiting, taken, done, failed, withdrawn), `transitions` ({ action, from, to, when, set, clear }), `remove_when`, `take_order` and `take_tries`. A condition is a rule group of the formula engine (rule-operators.json: `equals`, `at_least`, `at_most`, `is_unknown`, and the rest), decided by the engine over the signals `is_taker`, `is_sender`, `addressed_to_me`, `taken_minutes` and `terminal`; a row with no `when` holds for every AI (stuck and unstuck, so a watcher can flag a job; the note keeps who and when). `read_as` reads a stored status word as a declared state: `running`, written by other writers of long jobs, is `taken`, the one word for a job an AI is doing. The stale-take time (120 minutes as shipped) is the `taken_minutes` value of the take and release rows: change it there.
- **One current status, history in the store.** A job's `status` is its one current state. Its earlier values are the record's own version history in the person's account (the door's `history` operation), so the value keeps no second copy of past moves.
- **Same key, same job.** A job's id is `ai-job:<key>` (the request key of the run when no `key` is given), written on condition of absence: sending it again answers `already-there`. A retried run is answered the receipt the door already keeps.
- **Jobs written by others are taken the same way.** Recipe runs (`tools/workflows`, `tool:start-a-recipe-run`) insert rows into the table `ai_job` of the person's own database (`tools/workflows/sql/001-ai-job.sql`) with `status` waiting and no `to`; any AI may take them here.

## Checked completion and recovery

The saved `acceptance` is `{ outcome, target: { type, id }, rules }`. Each shared judge-words rule reads the persisted consumer through a `path` and a test such as `equals`; its id is `outcome` or a saved obligation id. An older or producer-created job can use `plan` while taken to save these checks without changing its requested work. Sender edits must leave acceptance consistent with the requirements.

`tool:finish-an-ai-job` reads that exact current consumer with an input-bound kind/id right, intersected with the caller's authority. It applies the existing judge, checks every saved obligation, and records the actual consumer and acceptance BLAKE3 identities against the original `taken_at`. Missing or failed reads, fabricated references, failed checks and stale claims leave work unfinished. The saved checks must still express the person's actual outcome; passing a predicate does not establish a correct requirement. Other consumer types need an appropriate existing observer; this record observer does not verify arbitrary external effects.

Recoverable work stays on the same job. `wait` records a known AI owner, exact action, reason and review time within `completion.max_resume_minutes`; `resume` returns due work to waiting. A bounded release also delays another take. The helper caps actual executions and parks exhausted attempts. Recovery inspects existing effects before retrying; an exit without a checked consumer remains blocked. Applicable unfinished actions remain owned by the saved obligations and continuation; completion creates no unrequested chain.

Holder actions carry the original `taken_at`, preventing an old run of the same AI from changing a later claim. Writes are read back, so a historical transport receipt cannot create current ownership. The current `running` DATA alias and watcher notes remain supported. System producers use `prepareProducedJob` in the same transaction as their source transition, keeping their real source, structured input and stable source-job identity with `from: null` rather than a fictional AI sender.

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

`trillion who` is `tool:see-my-ais`; `send` is `tool:hand-a-job-to-an-ai`; `work [ID]` is `tool:see-ai-work`; `take [ID] [--mine]` is `tool:take-an-ai-job`; `finish ID "RESULT" [--summary]`, `release ID [--because]`, `stuck ID "WORDS" | --clear` and `withdraw ID --reason` are `tool:change-an-ai-job` with action finish, release, stuck or unstuck, and withdraw. Each runs at the person's door as `tools:run` at `@tools`.

## Screens

Moved byte for byte from the web client (`moved-from.json` names each file's source path, commit and identity); the client build opens each from this folder as a screen module and shares the web shell's files it imports with the page.

| File | Purpose |
|------|---------|
| `web/src/workspace/job-run.tsx` | The screen: One job as the person watches it run (also drawn under the message box by the web client, which imports this file) (`tool:screen-job-run`) |
| `show/job-run-mount.tsx` | Its mount entry: the one `mount(element, props)` export the row's `screen.module.entry` names |
