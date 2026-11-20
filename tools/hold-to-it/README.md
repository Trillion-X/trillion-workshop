# tools/hold-to-it/

Holds a group to what it agreed. An agreement found in any transcript, message or meeting ("we need to meet every day", and everyone said yes) is answered as an agreement for the caller to keep. For an agreement with a time, `tool:hold-to-it` works out the next meeting and when to remind and when to check, checks afterwards who came from the evidence it is handed, marks each person, and answers the scorecard. Ported from the app's `src/hold-to-it.mjs`; the pure core (cadence windows, presence, marks, tallies) is carried, and the calls it made to spaces, the calendar, the wake and listening are the caller's.

Operations: `keep`, `retime`, `remind`, `check`, `mark` and `scorecard`. The tool reads and keeps nothing: the group's policy (`policy`), the held agreement (`agreement`) and the marks already held (`marks`) come in with the request, and the agreement (`agreement`) and each mark (`mark_records`, `mark_record`, with ids `record:agreement-marks:...`) come back in the answer for the person's AI to keep in a store. The marks and their points, the meeting length, the time zone and the reminder and check minutes are the policy handed in; there is no default. Nothing here names a person, team, kind of meeting or app that hears meetings.

Rules it keeps: a time nobody said is never guessed (an agreement without one is `needs_time` and arms nothing); presence is only what the caller hands in as evidence for the meeting's window, so a person with no evidence is absent and a voice with no name is unclear, never a guess; a mark is kept once per agreement, day, person and rule, so checking twice answers the same mark ids and never counts twice, and a newer mark for the same day replaces the older (that is how a wrong mark is corrected); a clock change is handled by `tools/wall-time`.

Nothing is sent or booked. The answer says the times to arm (the reminder and the check, as a repeat or once, with a schedule id taken from the agreement so arming again changes them instead of adding more) and the sentences to say; whoever runs the tool arms the wake, books the calendar (`tools/calendar`, `tools/book-time`), tells the group (`tools/notifications`, `tools/tell-the-person`) and brings the group in (`tools/form-groups-and-matches`).

**Heard turns:** the check takes `heard`, one row per speaker turn in the listening owner's shape (`{ start, end, speaker, me, voice, score, unsure?, text }`), and reads the speaker as the name. A speaker the policy's `unnamed_prefixes` names (a voice with no name, or one of several candidates) is an unclear voice, so nobody is marked absent on it. The caller reads the rows; this tool never reads a call. The live capture that writes them is not built yet, so until it is the caller hands in the names it has as `evidence`.

## Files

| File | Purpose |
|------|---------|
| `read-data/hold-to-it.mjs` | `holdToIt` and the pure core: `occurrences`, `aroundNow`, `armAt`, `presentAmong`, `marksFor`, `tally`. Its header lists the invariants. |
| `read-data/hold-to-it.json` | The record types, the default policy id and every sentence. |
| `tool-rows.json` | The row. |
| `part.json` | Nothing here is imported by other code. |
| `test/hold-to-it.test.mjs` | A made-up group, no records door handed to the run: keep with and without a time, retime, check from evidence, unclear voices, once-only marks, the scorecard and a correction, streaks, the missing policy, the pure parts and the row. |

## Dependencies

**Depends on:** `tools/run-work-later-or-on-a-repeat` (the timed-action engine: zones and clock changes), `tools/records-door` (only its `run-an-export.mjs` runner).

**Depended on by:** `tool-rows.json`; the workflows that name `tool:hold-to-it`.
