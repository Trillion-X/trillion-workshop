# tools/run-work-later-or-on-a-repeat/

Scheduled work as DATA: recurring schedules in any IANA time zone (daylight-saving gaps and folds decided by the schedule), one-off actions with their time windows, and the one call a Durable Object alarm makes on each wake to learn what is due and when to wake next.

## Files

| File | Purpose |
|------|---------|
| `part.json` | The files other code may import. |
| `what-this-tool-does-and-how-to-run-it.json` | `tool:when-to-run-next` (`whenToWake`) and `tool:plan-recurring-windows` (`planRecurringWindows`): old trillion's rows (records/workshop-engine-tool-records.json at old-trillion-before-worker-retire) with their words, schemas and sample runs unchanged, run as the engine's one WebAssembly component (`built-stored-bytes/component/timed-action.wasm`, argv `component`) on any computer, with no node. |
| `kits/when-to-run-next.json`, `kits/plan-recurring-windows.json` | Their kits, drafted by `tools/workflows/read-data/draft-a-kit.mjs` from each row and its real sample answer. |
| `crates/timed-action/` | The engine, in Rust: wall time in a named zone (`timeZoneName`, `instantAt`, `wallTimeOf` and the civil date steps), recurring windows, one-off due actions, fleet spread, quiet hours, zone drift and the scheduled-action writes. Its zones are jiff's bundled tz database (2026e), so every computer and page answers the same. See its README for each request's shape. |
| `built-stored-bytes/` | The engine built two ways: `timed-action/` (the wasm-bindgen module pages and Node tools call) and `component/timed-action.wasm` (the WASI component the tool rows run). Regenerate with `tools/build-engine-modules-for-web-hosts/build/build-timed-action.mjs`; never edit. |
| `do-work/timed-action.mjs` | The engine loaded once for a Node tool or test, every function re-exported. A browser bundle gets `do-work/timed-action-in-a-page.mjs` instead (the bytes ride in the bundle), by the `browser` field of `do-work/package.json`. |
| `do-work/quiet-hours.json` | Quiet-hours modes (DATA, read into the engine at build time and by the pages that name a mode). |
| `test/` | The TypeScript-era tests, run against the engine through `do-work/timed-action.mjs` with the same assertions. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `timeZoneName` / `instantAt` | `({value}) => string \| null` / `({date, time, zone, options: {gap?: 'skip'\|'next-valid', fold?: 'earlier'\|'later'}}) => number \| null` | The one zone test and the one local-time-to-instant rule (gap: next minute that exists by default; fold: earlier by default). |
| `whenToWake` | `(WakeInput) => {now, recurring_due, materializations, scheduled_due, next_wake_at, rejected_schedules, skipped_resolutions}` | The alarm's question, answered purely from DATA and the given `now`. |
| `RecurringWindowSchedule` | `{schedule_id, source_generation, schedule_revision, timezone, start_local_date, cadence:{unit:'minute'\|'hour'\|'day'\|'week', interval?, weekdays?}, local_window:{start:'HH:MM', duration_minutes}, dst?:{gap?:'skip'\|'next-valid', fold?:'earlier'\|'later'\|'both'}, action:{operation, owner_ref, owner_dispatch:{name, input}}}` | A recurring schedule. `minute`/`hour` repeat every day on the grid through `local_window.start` (every 2 hours at 09:30 is 01:30, 03:30 ... 23:30), at least `MIN_STEP_MINUTES` (5) and at most a day apart; `day`/`week` run once at the start. |
| `RecurringOccurrenceState` | `{occurrence_key, materialization_key?, materialized_at?, owner_outcome?:{proven, owner_ref, proof_ref, observed_at}}` | What was recorded for an occurrence; only a complete proven outcome advances. |
| `materializeRecurringWindows` | `({schedules, occurrence_states, max_calendar_scan_days?, now_ms?, resume_from_ms?}) => {materializations, active_occurrences, rejected_schedules, skipped_resolutions}` | Recurrence reduction. With `now_ms`, every schedule (minutes, hours, days or weeks) passes over an unproven time whose next time has also come, so one asleep runs once on waking, for its latest time, and that occurrence's `missed_before` says how many times it passed over (0 on time) since `missed_since`; the scan starts within `max_calendar_scan_days` of now, so a schedule begun decades ago is still due at its latest time. One already dispatched is never passed over. |
| `MIN_STEP_MINUTES` | `5` | The shortest step a schedule may repeat on; `src/automations.mjs` reads the same constant. |
| `recurringOccurrenceKey` | `({identity}) => string` | The compare-and-exchange key for one occurrence. |
| `evaluateDueScheduledActions` | `({time_windows, actions, receipts, now}) => {due, due_count, ...}` | One-off due reduction. |
| `actionOperation`, `receiptKey`, `resolveDueAt` | helpers | How an action is named, deduplicated and timed. |
| `buildScheduledActionRecordWrite`, `buildScheduledActionStateWrite`, `buildReplaceTimeWindowWrite` | `(input) => {writes, ...}` | Record write intents. |

## Using it from a Durable Object alarm

On each `alarm()`: read the person's schedules, occurrence states, time windows, actions and receipts; call `whenToWake({ now: Date.now(), ... })`; record each `materializations` entry (compare-and-exchange on its key); run each `recurring_due` occurrence's `action.owner_dispatch` and each `scheduled_due` action's row `dispatch`; on success write the occurrence's `owner_outcome` proof or the action's receipt; then `setAlarm(next_wake_at)` (sooner when something due failed). `test/timed-action/when-to-wake.test.mjs` runs that loop across the New York clock change.

## Dependencies

**Depends on:** `crates/timed-action` (built into `built-stored-bytes/`); `do-work/quiet-hours.json`. No host zone data: the zones are compiled in.

**Depended on by:** `tools/notice-when-something-shows-up` (`do-work/mechanisms/due-time.mjs`, `whenToWake`), `tools/plan-tasks-and-todo-lists` (`calendar-tasks.mjs`), `tools/hold-to-it`, `tools/book-time`, `tools/booking-slots-and-invitations`, `tools/run-a-community`, `tools/send-messages`, `tools/screen-looks`, `tools/choose-and-publish-screen-looks`, `tools/find-when-a-space-is-free`, `tools/keep-lists-of-rows`, `tools/social-posts`, `tools/set-up-my-account`, `tools/shared-code` (`typed-operation-contract.mjs`), `tools/workspace-screens` (show rules, through the page loader). Ported from bitfield-packages `packages/timed-action/do-work`; the TypeScript and `tools/wall-time` it replaced were deleted with this engine's landing.

## Ported in the verify-every-port L05 pass (Nov 20 2026)

- `read-data/schedule-graph.mjs`: the schedule projection (old Bitfield `read-data/read-scheduled-action-graph.ts`, commit d926b7adb8). Its old test is `test/schedule-graph.test.mjs` (4 old assertions groups plus one receipt test), 5 pass.
- Not wired: no tool row serves this read yet, so no screen or workflow calls it (LOST-UNWIRED until a tool row exists; handoff row under the verify-every-port tool row).
- Still lost: C21 fire one due action from its row's dispatch and C22 run the owner action first (both need the workflow runner design; gap at `do-work/mechanisms/due-time.mjs:196-214`); C13 materialization consumer (no reader of `materializations`); C17 schedule-record writer (no tool row defines it, and `tools/autonomous-agent-tick/packages/autonomous-agent-tick/things-to-store-and-run.json` still names `action:timed-action.write-scheduled-action` as owner_target, a live break); C25 screen.
- C11 (owner outcome proof needs owner_ref, proof_ref and observed_at) is KEPT: `crates/timed-action/src/recurring.rs:269-274`. The earlier LOST verdict was stale.
