# tools/plan-my-time/

Places a person's tasks into their free time and judges their meetings against their pursuits: ASAP first, then hard deadlines, then what serves their most important pursuit, then due date. It changes no calendar; the caller applies the result with the calendar actions. Learned from an auto-scheduling calendar and a daily planner (reverse engineered 2026-10-15).

## Files

| File | Purpose |
|------|---------|
| `do-work/plan-my-time.mjs` | `planMyTime(request)`: pure, deterministic, no calendar or network. Free time from the weekly schedule in the person's zone minus busy events, then each task placed in rank order; meetings proposed for decline; each day against its cap. |
| `read-data/rules.json` | The planning policy as DATA: window, stale days, chunk sizes, pursuit and priority weights, the default weekly schedule, gap, slot choice, daily caps, the rollover alert and named schedules. A request overrides any of it under `rules`. |
| `tool-rows.json` | The rows `tool:plan-my-time`, `tool:plan-a-schedule-around-events` and `tool:timebox-a-planned-task`, run in the small container. |
| `test/plan-my-time.test.mjs` | The plan's behaviour on small weeks, and the row's own sample run. |
| `do-work/schedule-planner.mjs`, `do-work/schedule-planner.d.mts`, `read-data/schedule-planner.json` | `planSchedule(tasks, events, options)`, moved from old trillion's calendar: bounded, read-only work-hour slots around existing events. Deadline type (hard binds, soft may be late, none ignores due) and priority (ranks only) are independent axes; `blocked_by` waits for those tasks; an automatically placed task a person moved stays while `pinned_until` is live (`kept`) and goes back to the planner after (`released`); `capacity` caps a weekday's minutes (default 480) and each day reports ok, caution or over; `day_overrides` change one day; every unplaced task gets one reason by `reason_precedence`. Order, deadline kinds, statuses and precedence are DATA. |
| `do-work/schedule-placement.mjs`, `do-work/schedule-placement.d.mts` | The local day keys and times the planner is made of (day keys never slip across a zone or a clock change), moved whole with the calendar's view arithmetic. |
| `do-work/timebox-policy.mjs`, `do-work/timebox-policy.d.mts`, `read-data/timebox-policy.json` | `timeboxEvent(policy, task, proposal, privacy)`: whether and how a planned task becomes an event on the person's own calendar (off by default, free, busy, or busy only when at risk or high priority), exactly at the proposed placement. |
| `do-work/schedule-requests.mjs` | The two rows over them: `planScheduleAroundEvents({ tasks, events, options, time_zone })` and `timeboxEventFor({ policy, task, proposal, todo_privacy })`. |
| `test/schedule-calendar-planner.test.mjs`, `test/schedule-calendar-placement.test.mjs`, `test/timebox-policy.test.mjs` | The moved modules' own tests, as they were. |
| `test/schedule-rows.test.mjs` | The two planner rows' sample runs and refusals. |
| `part.json` | Nothing here is imported by other code. |

## How a plan is made

- **Order:** a fixed-time task (`rigid` with `preferred_start`) first, then ASAP, then hard deadlines, then value (pursuit weight times priority weight), then due date. A task waits for the tasks that block it.
- **Free time:** the schedule's hours, minus busy events (declined, all-day and shown-as-free ones take no time), blocks and work already placed, with `gap_minutes` kept around each.
- **Splitting:** a task shorter than the rules' first chunk is never split; a longer one is split only into pieces of at least the minimum block the rules give for its length.
- **Fit:** every task comes back `on_track`, `past_due`, `unfit_past_due`, `unfit_later`, `needs_decision`, `conflict`, `blocked` or `not_planned`, with the words that say why. A hard deadline may use time outside working hours and says so.
- **Meetings:** one that serves no pursuit and is not required is proposed for decline, lowest value first, only while that lets more valuable work meet its deadline. Nothing is declined here.
- **Days:** each day's planned minutes against its cap, with the lowest-value movable tasks to move first (never fixed-time or ASAP ones).

## Dependencies

**Depends on:** `tools/records-door` (the command that runs a function), `tools/content-identity`; Node 22.

**Depended on by:** nothing is imported from here.
