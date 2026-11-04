# parts/timed-action/

Scheduled work as DATA: recurring schedules in any IANA time zone (daylight-saving gaps and folds decided by the schedule), one-off actions with their time windows, and the one call a Durable Object alarm makes on each wake to learn what is due and when to wake next.

## Files

| File | Purpose |
|------|---------|
| `part.json` | The files other code may import. |
| `do-work/when-to-wake.ts` | `whenToWake({now, schedules, occurrence_states, time_windows, actions, receipts})`: what is due now, which occurrences to record, `next_wake_at` for the alarm. |
| `do-work/materialize-recurring-windows.ts` | `materializeRecurringWindows`: each schedule's one unresolved occurrence window with a stable `occurrence_key` (schedule id, requested and resolved local windows, zone, generation, revision, fold branch); advances only on a proven owner outcome. |
| `do-work/wall-time.ts` | Wall time in a named zone for every owner that keeps a time a person said: `timeZoneName` (the canonical IANA name, or null for an offset, an unknown name or nothing, never UTC), `instantAt(date, time, zone, { gap, fold })` (one clock-change rule), `wallTimeOf`, and the civil date steps the materializer uses. Schedules, held agreements (`src/hold-to-it.mjs`), repeating community events, posts, calendar repeats, view zones, share-link and show-rule zones and look zones all read it. |
| `do-work/evaluate-due-scheduled-actions.ts` | `evaluateDueScheduledActions`: one-off actions whose window has opened and that no receipt names yet; a row without its own `dispatch` never fires. |
| `do-work/spread-fires.ts` | `spreadRecurringStart`, `spreadOneShotDue`, `fractionOf`, `intervalMsOf`: deterministic fleet spread (recurring later within a cap, one-off round minutes only earlier, never before creation). `whenToWake` applies it only when given `spread` (src/scheduler.json `spread`, `on: false` by default). |
| `do-work/write-scheduled-action-record.ts` | Write intents for a scheduled action's record, its state and receipt, and a replaced time window. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `timeZoneName` / `instantAt` | `(value) => string \| null` / `(date, time, zone, {gap?: 'skip'\|'next-valid', fold?: 'earlier'\|'later'}) => number \| null` | The one zone test and the one local-time-to-instant rule (gap: next minute that exists by default; fold: earlier by default). |
| `whenToWake` | `(WakeInput) => {now, recurring_due, materializations, scheduled_due, next_wake_at, rejected_schedules, skipped_resolutions}` | The alarm's question, answered purely from DATA and the given `now`. |
| `RecurringWindowSchedule` | `{schedule_id, source_generation, schedule_revision, timezone, start_local_date, cadence:{unit:'minute'\|'hour'\|'day'\|'week', interval?, weekdays?}, local_window:{start:'HH:MM', duration_minutes}, dst?:{gap?:'skip'\|'next-valid', fold?:'earlier'\|'later'\|'both'}, action:{operation, owner_ref, owner_dispatch:{name, input}, completion:{mode:'synchronous-owner-return'}}}` | A recurring schedule. `minute`/`hour` repeat every day on the grid through `local_window.start` (every 2 hours at 09:30 is 01:30, 03:30 ... 23:30), at least `MIN_STEP_MINUTES` (5) and at most a day apart; `day`/`week` run once at the start. |
| `RecurringOccurrenceState` | `{occurrence_key, materialization_key?, materialized_at?, owner_outcome?:{proven, owner_ref, proof_ref, observed_at}}` | What was recorded for an occurrence; only a complete proven outcome advances. |
| `materializeRecurringWindows` | `({schedules, occurrence_states, max_calendar_scan_days?, now_ms?}) => {materializations, active_occurrences, rejected_schedules, skipped_resolutions}` | Recurrence reduction. With `now_ms`, a schedule that repeats within the day passes over an unproven step whose next step has also come, so it runs once on waking instead of once per missed step. |
| `MIN_STEP_MINUTES` | `5` | The shortest step a schedule may repeat on; `src/automations.mjs` reads the same constant. |
| `recurringOccurrenceKey` | `(identity) => string` | The compare-and-exchange key for one occurrence. |
| `evaluateDueScheduledActions` | `({time_windows, actions, receipts, now}) => {due, due_count, ...}` | One-off due reduction. |
| `actionOperation`, `receiptKey`, `resolveDueAt` | helpers | How an action is named, deduplicated and timed. |
| `buildScheduledActionRecordWrite`, `buildScheduledActionStateWrite`, `buildReplaceTimeWindowWrite` | `(input) => {writes, ...}` | Record write intents. |

## Using it from a Durable Object alarm

On each `alarm()`: read the person's schedules, occurrence states, time windows, actions and receipts; call `whenToWake({ now: Date.now(), ... })`; record each `materializations` entry (compare-and-exchange on its key); run each `recurring_due` occurrence's `action.owner_dispatch` and each `scheduled_due` action's row `dispatch`; on success write the occurrence's `owner_outcome` proof or the action's receipt; then `setAlarm(next_wake_at)` (sooner when something due failed). `test/timed-action/when-to-wake.test.mjs` runs that loop across the New York clock change.

## Dependencies

**Depends on:** `Intl.DateTimeFormat` with IANA zones (Workers and Node carry the zone data); nothing else.

**Depended on by:** `src/scheduler.mjs` (the one alarm owner of every Durable Object: PersonStore, Network, HostedService), `src/automations.mjs` (a person's schedules), `test/timed-action/` (the ported tests and the alarm loop). Ported from bitfield-packages `packages/timed-action/do-work`; its surfaces (`show/`, `read-data/`), process-script wrappers and the clock-tick workflow rows stay there, since a Durable Object alarm is Trillion's clock.
