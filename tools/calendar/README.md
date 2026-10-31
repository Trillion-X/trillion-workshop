# tools/calendar/

A person's calendar, built from their own records. Any records that have a start and an end (bookings, scheduled work, reservations, events) become time blocks through a lens the person writes; the blocks are laid out for a day, week, month or agenda view with overlapping blocks in columns and clashes named; and events can be read from the person's own Google calendar with their own credential. Three Workshop tools run in the deployed tool container: `tool:read-time-blocks`, `tool:lay-out-a-calendar-view` and `tool:read-google-calendar-events`. Ported from bitfield-packages `packages/calendar` (its time-block projection, account and sync-state readers, view descriptors, day and month grids, overlap packing, and the request and normalizer of its Google sync); its drawing was not brought in (see Not brought in). Nothing here writes a calendar.

## Files

| File | Purpose |
|------|---------|
| `read-data/time-blocks.mjs` | `readSelector` (path, column, fallback), `readTimeBlocks` (lenses over rows into ordered blocks, with an issue for a lens that is unusable or has no rows), `readAccounts`, `readSyncStates` (queued changes and conflicts as blocks). |
| `read-data/calendar-views.mjs` | `chooseView`, `timeGridDays`, `monthGridDays`, `packOverlappingBlocks`, `clashesOf`, `layOutView` (the person's own days by UTC offset; time grid, month grid, agenda list). |
| `read-data/google-events.mjs` | `requestProblems`, `eventsUrl`, `readEvents`: the Google events request and the reading of its answer as blocks. |
| `do-work/command.mjs` | How every command here runs: JSON on stdin, one JSON line out, a refusal on stderr. |
| `do-work/read-time-blocks.mjs` | The command of `tool:read-time-blocks`. |
| `do-work/lay-out-a-calendar-view.mjs` | The command of `tool:lay-out-a-calendar-view`. |
| `do-work/read-google-calendar-events.mjs` | The command of `tool:read-google-calendar-events`: the only place the three credentials are read and sent. |
| `tool-rows.json` | The three rows. |
| `part.json` | No public files: only the tools run this code. |
| `test/time-blocks.test.mjs` | The package's projection, account and sync-state cases on a bakery's pickups, plus unusable and empty lenses. |
| `test/calendar-views.test.mjs` | The package's overlap and view cases, plus offsets, month, agenda, clashes and a view the code never named. |
| `test/google-events.test.mjs` | The request, the reading, and the sending against a stand-in network, with no credential in any answer. |
| `test/calendar-tools.test.mjs` | Each tool run the way its row runs it, the verify samples, refusals listing every problem. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| time-block-lens | `{ kind, lens_id, input_address, owner_ref, owner_label?, selectors: { identity, start, end, title?, all_day?, timezone?, color?, state?, lane? }, relations? }` | How one kind of record becomes blocks. A selector is a path or `{ path \| column, fallback_path?, fallback? }`. |
| time block | `{ id: "owner:lens:row", source, interval: { start, end, allDay, timezone }, display: { title, color, ownerLabel }, state: { ref, lane }, relations }` | One thing in time. |
| calendar-view-descriptor | `{ kind, view_id, label?, layout: "time-grid" \| "month-grid" \| "agenda-list", order?, day_count?, skip_weekends?, max_chips_per_cell? }` | One view; the person's own record. |
| `layOutView` | `({ blocks, views, view_id?, anchor?, range_start?, selected_block_id?, utc_offset_minutes? }) => { view, days, clashes, skipped, notice? }` | The days to show and what is on each. |
| `readGoogleCalendarEvents` | `(input, { credentials, fetchImpl }) => { blocks, issues, source }` | One token request and one events request. |

## Invariants

- No kind of record, provider, state, colour or view is built in; all come from the person's lenses and views. A court booking resolves through the same code as a bakery's pickups.
- There is no clock. The day to show comes from the anchor, the selected block, the first block or the range start; asked for none of them, the answer says so.
- Days are the person's own: a UTC offset moves every timed instant before it is cut into a day; an all-day block is a date and is not moved.
- The Google credentials (client id, client secret, refresh token) arrive only on descriptors 3, 4 and 5 under the held-value names the row names, are used for one token request and one events request, and are taken out of anything Google says before it is shown.

## Not brought in

- **Drawing** (`show/*.tsx`, `show-ios-jscore/*`, the screen model with its sample date and copy, the account rail, the detail panel, hour-grid drawing, the proof harness and rendered screens) stays with the screens owner. It only draws what these tools give back.
- **Owner-action handoff** (`do-work/run-calendar-owner-action.ts`, the `action:calendar.owner-action` rows, the action templates on lenses and queued changes) addressed the old engine's workflow slot (`slot::workflow`, `execute_definition`). A person's AI acts through the tools that own each job, so blocks here carry no action descriptors.
- **Lens and view enumeration through the old engine** (`read-calendar-lens-feeds.ts`, `read-calendar-view-descriptors.ts`): finding the lens and view records and reading each lens's rows is the records door's job; the caller passes what it read.
- **Built-in views and states** (the shipped day, week, month and agenda rows with their hour window, the state labels, the account colours): a person's views are their own records.
- **Webhook-free sync workflow** (the vault-handle steps, the feed write, the surface state and action list in the feed): replaced by one tool that reads with held values and writes nothing.

## Behaviour that differs from the package

- A row list that cannot be read as rows is no longer dropped silently: a lens that is unusable, or has no rows given, is an issue.
- A conflict row that could not be shown no longer shifts the original interval onto the next conflict.
- A cancelled Google event has state `cancelled` (the package called it `offline`, a screen word); a Google event with no title is `Untitled`; no brand colour is set; the account is the caller's `connection_ref`, not an old engine identity.
- The Google range is named by the caller; the package filled it from the clock.
- The Google events request gains `calendar_id` (the package read only the primary calendar) and `max_results` is bounded to what Google allows.
