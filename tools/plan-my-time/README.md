# tools/plan-my-time/

Places a person's tasks into their free time and judges their meetings against their pursuits: ASAP first, then hard deadlines, then what serves their most important pursuit, then due date. It changes no calendar; the caller applies the result with the calendar actions. Learned from an auto-scheduling calendar and a daily planner (reverse engineered 2026-10-15).

## Files

| File | Purpose |
|------|---------|
| `do-work/plan-my-time.mjs` | `planMyTime(request)`: pure, deterministic, no calendar or network. Free time from the weekly schedule in the person's zone minus busy events, then each task placed in rank order; meetings proposed for decline; each day against its cap. |
| `read-data/rules.json` | The planning policy as DATA: window, stale days, chunk sizes, pursuit and priority weights, the default weekly schedule, gap, slot choice, daily caps, the rollover alert and named schedules. A request overrides any of it under `rules`. |
| `tool-rows.json` | The row `tool:plan-my-time`, run in the small container. |
| `test/plan-my-time.test.mjs` | The plan's behaviour on small weeks, and the row's own sample run. |
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
