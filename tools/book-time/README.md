# tools/book-time/

Booking time with a person: the times they can be booked, booking one, moving a booking through its lifecycle, and putting, moving or cancelling the event on their own Google calendar, or making the invitation file any mail client understands. Ported from bitfield-packages `packages/calendar-booker`: the open-time derivation, the calendar account's calls and the invitation file are the package's; the booking record, its lifecycle and the rows are written to take bookings as input and answer the result.

- **Nothing is assumed.** Weekly windows, lengths, buffers, notice and the time zone are the person's own and arrive in the request. A booking type, a host and a title are the person's words.
- **Open means open now.** A time is open when it fits a window, does not touch a busy interval widened by the buffers, and starts after the notice. A held booking fills a seat of the time it starts at (`seats_per_slot`, 1 when left out) and blocks every other time it overlaps; once `per_day_max` bookings start on a day the rest of it closes; nothing past `horizon_days` is offered. A request to book checks that against the `bookings` it is given.
- **Tools keep nothing.** Every answer is the result (a booking record, a list of times, an event id); the person's AI keeps it where the person keeps bookings and hands the bookings a tool must look at back as `bookings` in the next request. Which of two simultaneous requests gets the last seat is decided by whatever keeps the bookings, not here.
- **A waiting booking holds its time unless told not to.** With `pending_blocks_slot: false` a booking waiting for the host leaves its time open to others, and confirming it checks the time again; a waiting booking whose time has passed can be cancelled but not confirmed. The rules a booking was made under are carried on its record as `time_rules`.
- **The calendar account is the person's own.** Calendar rows take one held value, `calendar-account`, a JSON object `{ provider, client_id, client_secret, refresh_token, calendar_id? }`, on descriptor 4. It is never printed, logged or returned, and provider text in an answer is scrubbed of its parts. Only `google` is read today; a new provider is one adapter entry.
- **A calendar that cannot be read is unknown, never free.**

## The booking lifecycle

`read-data/booking-lifecycle.json` is `{ stages, transitions, start }`, the shape `tools/move-records-through-declared-states` reads, so an AI can also ask that tool where a booking may go next. `tool:change-a-booking-status` reads the same file and refuses a move it does not list; a test keeps it sound (every move names declared stages, nothing leaves a finished stage, every stage is reachable).

## Files

| File | Purpose |
|------|---------|
| `read-data/derive-open-slots.ts` | `deriveOpenSlots`: weekly windows minus taken starts, buffered busy intervals and notice, zone- and clock-change-aware through the timed-action engine (`tools/run-work-later-or-on-a-repeat`: `instantAt`, `timeZoneName`, `weekday`, `pad`), the one owner of a local time in a zone: a time the clock skips is not offered and a time it repeats is offered once, at the earlier. Copied but for its path line and that import. |
| `read-data/booking-lifecycle.json` | The booking's stages and moves. |
| `do-work/create-external-calendar-event.ts` | Makes the event (and, when asked, the video call); the Google adapter and the account's token call. Comments only changed. |
| `do-work/external-calendar-busy-and-changes.ts` | Reads busy intervals, moves and cancels an event. Unchanged but for its path line. |
| `do-work/calendar-invite-file.ts` | The RFC 5545 file for a request or a cancel. Changed: the producer id and a comment. |
| `do-work/book-time.mjs` | The tool seam, run by `tools/records-door/do-work/run-an-export.mjs`. |
| `what-this-tool-does-and-how-to-run-it.json` | Eight rows. |
| `part.json` | No public files. |
| `test/derive-open-slots.test.mjs`, `test/external-calendar.test.mjs` | The package's cases, plus busy, move and cancel. |
| `test/calendar-invite-file.test.mjs`, `test/booking-lifecycle.test.mjs` | The file's shape; the lifecycle's soundness. |
| `test/book-time-rows.test.mjs` | The tools called as the runner calls them with no records door; calendar tools with a stand-in account and transport. |
| `test/seats-limits-and-answers.test.mjs` | Seats, the day limit, the horizon, overlap and a waiting booking's time, each answer handed back as the next call's `bookings`. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| `booking` record (answered, never kept here) | `{ id, host_ref?, booking_type?, title?, status, scheduled_start, scheduled_end, timezone, attendees, time_rules, idempotency_key, created_at, updated_at, external_calendar_event_id?, meeting_url?, cancelled_at?, cancellation_reason? }` | One booking, id `booking:<idempotency_key>`. |
| `tool:find-open-times` | `{ timezone, windows, from_date, days?, duration_minutes, step_minutes?, buffers?, min_notice_minutes?, taken?, busy?, bookings?, seats_per_slot?, per_day_max?, horizon_days?, pending_blocks_slot? } -> { slots: [{ ..., seats_left? }] }` | The open times. |
| `tool:request-a-booking` | `{ bookings?, idempotency_key, start, timezone, windows, duration_minutes, needs_payment?, needs_confirmation?, attendees?, seats_per_slot?, per_day_max?, horizon_days?, pending_blocks_slot? } -> { already_requested, booking }` | Answers one booking record. |
| `tool:change-a-booking-status` | `{ booking, to, reason?, bookings? } -> { changed, booking }` | Answers the moved record; only lifecycle moves. |
| `tool:check-when-i-am-busy` | `{ from, to } -> { status: read \| unknown, busy }` | Needs `calendar-account`. |
| `tool:put-a-booking-on-my-calendar` | `{ title, start_local, end_local, timezone, attendees?, video_call_request_id?, } -> { status, external_event_id?, html_link?, video_link? }` | Needs `calendar-account`. |
| `tool:move-a-booking-on-my-calendar`, `tool:cancel-a-booking-on-my-calendar` | `{ event_id, start, end }`, `{ event_id }` -> `{ status }` | Need `calendar-account`. |
| `tool:make-a-calendar-invite` | `{ uid, start, end, summary, organizer, attendees?, method?, sequence? } -> { filename, text }` | Sends nothing. |

## Dependencies

**Depends on:** `tools/records-door`'s `run-an-export.mjs` as the runner every row names (packed at `/opt/records-door`); no tool here opens a records door. Node 24 in the tool container runs the `.ts` files by stripping their types.

**Depended on by:** Trillion's deploy reads `what-this-tool-does-and-how-to-run-it.json`.
