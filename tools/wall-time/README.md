# tools/wall-time/

The one place a local date and clock time ("2026-11-01", "09:00", "America/New_York") becomes an instant and back, and the one test of whether a zone name is a zone. A library: it offers no tool of its own. Every tool that keeps a time a person said in their own clock (held agreements, schedules, events, posts, calendar repeats) reads it here, so a clock change is handled one way everywhere (`tools/book-time` reads it for the times a person can be booked). Ported from the app's timed-action wall-time owner.

A zone is an IANA name the runtime knows, kept in its canonical spelling; an offset, an unknown abbreviation or an empty value is refused, never read as UTC. A local time the clocks skip (spring forward) is a gap, one that happens twice (fall back) is a fold, and the caller's policy decides: a gap is skipped or moved to the next minute that exists, a fold takes the earlier, the later or both. Pure: no clock is read and nothing is stored.

## Files

| File | Purpose |
|------|---------|
| `read-data/wall-time.mjs` | `timeZoneName`, `instantAt`, `wallTimeOf`, `resolveStart`, `possibleInstants`, civil date and time arithmetic (`addCivilDays`, `addCivilMonths`, `addCivilMinutes`, `weekday`) and the cached formatters. Its header lists the invariants. |
| `part.json` | The file other tools import. |
| `test/wall-time.test.mjs` | Zone names, a gap and a fold in two zones, half-hour zones, a day that is not one, an offset refused, and month arithmetic. |

## Dependencies

**Depends on:** Node 24 only.

**Depended on by:** `tools/hold-to-it`.
