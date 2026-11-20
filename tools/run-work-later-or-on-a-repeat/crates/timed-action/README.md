# crates/timed-action/

When work is due, on a repeat or once, and wall time in a named zone. It replaced the TypeScript that was in `../../do-work/` and `tools/wall-time`. One crate, built two ways (see `../../built-stored-bytes/`).

## Files

| File | Purpose |
|------|---------|
| `src/lib.rs` | The module list and the invariants every module keeps |
| `src/js.rs` | JavaScript value rules: truthiness, `String()`, `Number()`, Number::toString, JSON text, Map keys, refusals with their error kinds |
| `src/date.rs` | Date rules: TimeClip, civil fields, `toISOString`, `Date.parse` for ISO text (with the V8 leniencies listed in the module) |
| `src/collation.rs` | `localeCompare` order: ICU root collation for ASCII (read off Node's ICU 77.1); code point after ASCII otherwise |
| `src/wall_time.rs` | wall-time.mjs: zone names, gaps and folds, civil arithmetic, `resolveStart`, `instantAt` (zones from jiff's bundled tz database) |
| `src/spread.rs` | spread-fires.ts: BLAKE3 fraction, recurring slip and one-off early move |
| `src/recurring.rs` | materialize-recurring-windows.ts: `materializeRecurringWindows`, `planRecurringWindows`, `recurringOccurrenceKey` |
| `src/when_to_wake.rs` | when-to-wake.ts: `whenToWake` |
| `src/evaluate.rs` | evaluate-due-scheduled-actions.ts: `evaluateDueScheduledActions`, `actionOperation`, `receiptKey`, `resolveDueAt` |
| `src/quiet_hours.rs` | quiet-hours.ts: `checkedWorkingHours`, `quietHoursAnswer`; modes read from `../../do-work/quiet-hours.json` |
| `src/zone_drift.rs` | zone-drift.ts: `zoneDrift` |
| `src/records.rs` | write-scheduled-action-record.ts: the three record writers |
| `src/requests.rs` | The one table of exports and their request shapes |
| `src/host.rs` | wasm-bindgen exports (`wasm32-unknown-unknown`) |
| `src/main.rs` | WASI command (`wasm32-wasip2`) |
| `tests/ported_cases.rs` | The TypeScript test cases ported one for one |

## Request shapes

A function that takes one object is called with that object as the request (`whenToWake(input)` takes `input`). A function with
several positional arguments takes named fields with the TypeScript parameter names (`instantAt({ date, time, zone, options })`,
`quietHoursAnswer({ hours, atMs, mode, dismissedPeriodStartMs })`, `zoneDrift({ planningZone, deviceZone, askedZones })`).

## How it answers differently from the TypeScript it replaced (each one reported, none hidden)

- Zone names: ICU canonicalises some names (`GMT` to `UTC`, `Asia/Kolkata` to `Asia/Calcutta`, `Europe/Kyiv` to `Europe/Kiev`,
  `US/Eastern` to `America/New_York`, `EST5EDT` to `America/New_York`); jiff keeps the bundled spelling. `Factory` is a zone
  jiff knows and ICU refuses.
- Zone data: Node's ICU (tzdata 2025b) was out of date; jiff-tzdb 0.1.9 bundles tzdata 2026e. On Nov 19 2026 every zone the
  two disagreed on (Havana from 2026-11-01, Casablanca's future Ramadan changes, Tehran 1979, Bogota 1992, Brazil 1965) was
  checked against the Mac's own tzdata 2026f: the engine agreed with it in every case, the TypeScript in none.
- `Date.parse`: the V8 legacy forms (`2026-3-1`, `2026/03/01`, `March 1, 2026`, `Sun Mar 01 2026 ...`) are refused here.
  Date-time text with no offset is UTC here, and the host's zone in the TypeScript.
- `localeCompare` for text past ASCII: code point order after ASCII, not ICU order (`é` sorts after `z` here, with `e` in ICU).
- `evaluateDueScheduledActions` with no `now` is refused; the TypeScript reads the system clock.
- `formatterFor` (returns a live Intl object) is not exported; `DAY_MS` and `MIN_STEP_MINUTES` are exported as functions.
