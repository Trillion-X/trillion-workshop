# tools/book-time/

Booking time with a person: the times they can be booked, booking one, moving a booking through its lifecycle, and putting, moving or cancelling the event on their own Google calendar, or making the invitation file any mail client understands. Ported from bitfield-packages `packages/calendar-booker`: the open-time derivation, the calendar account's calls and the invitation file are the package's; the booking record, its lifecycle and the rows are written for the records door.

- **Nothing is assumed.** Weekly windows, lengths, buffers, notice and the time zone are the person's own and arrive in the request. A booking type, a host and a title are the person's words.
- **Open means open now.** A time is open when it fits a window, is not a booking's start, does not touch a busy interval widened by the buffers, and starts after the notice. A request to book re-checks that against the person's own booking records, so a stale list cannot book a taken time.
- **The calendar account is the person's own.** Calendar rows take one held value, `calendar-account`, a JSON object `{ provider, client_id, client_secret, refresh_token, calendar_id? }`, on descriptor 4. It is never printed, logged or returned, and provider text in an answer is scrubbed of its parts. Only `google` is read today; a new provider is one adapter entry.
- **A calendar that cannot be read is unknown, never free.**
- **The records door has no compare-and-swap.** Two requests for one time in the same instant can both pass the open check, so a busy host should book through one writer.

## The booking lifecycle

`read-data/booking-lifecycle.json` is `{ stages, transitions, start }`, the shape `tools/move-records-through-declared-states` reads, so an AI can also ask that tool where a booking may go next. `tool:change-a-booking-status` reads the same file and refuses a move it does not list; a test keeps it sound (every move names declared stages, nothing leaves a finished stage, every stage is reachable).

## Files

| File | Purpose |
|------|---------|
| `read-data/derive-open-slots.ts` | `deriveOpenSlots`: weekly windows minus taken starts, buffered busy intervals and notice, zone- and clock-change-aware. Copied unchanged but for its path line. |
| `read-data/booking-lifecycle.json` | The booking's stages and moves. |
| `do-work/create-external-calendar-event.ts` | Makes the event (and, when asked, the video call); the Google adapter and the account's token call. Comments only changed. |
| `do-work/external-calendar-busy-and-changes.ts` | Reads busy intervals, moves and cancels an event. Unchanged but for its path line. |
| `do-work/calendar-invite-file.ts` | The RFC 5545 file for a request or a cancel. Changed: the producer id and a comment. |
| `do-work/book-time.mjs` | The tool seam, run by `tools/records-door/do-work/run-an-export.mjs`. |
| `tool-rows.json` | Eight rows. |
| `part.json` | No public files. |
| `test/derive-open-slots.test.mjs`, `test/external-calendar.test.mjs` | The package's cases, plus busy, move and cancel. |
| `test/calendar-invite-file.test.mjs`, `test/booking-lifecycle.test.mjs` | The file's shape; the lifecycle's soundness. |
| `test/book-time-rows.test.mjs` | Rows run as the container runs them against the fake records door; calendar rows with a stand-in account and transport. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| `booking` record | `{ id, host_ref?, booking_type?, title?, status, scheduled_start, scheduled_end, timezone, attendees, idempotency_key, created_at, updated_at, external_calendar_event_id?, meeting_url?, cancelled_at?, cancellation_reason? }` | One booking, id `booking:<idempotency_key>`. |
| `tool:find-open-times` | `{ timezone, windows, from_date, days?, duration_minutes, step_minutes?, buffers?, min_notice_minutes?, taken?, busy?, use_my_bookings? } -> { slots }` | The open times. |
| `tool:request-a-booking` | `{ idempotency_key, start, timezone, windows, duration_minutes, needs_payment?, needs_confirmation?, attendees? } -> { already_requested, booking }` | Keeps one booking. |
| `tool:change-a-booking-status` | `{ booking_id, to, reason? } -> { changed, booking }` | Only lifecycle moves. |
| `tool:check-when-i-am-busy` | `{ from, to } -> { status: read \| unknown, busy }` | Needs `calendar-account`. |
| `tool:put-a-booking-on-my-calendar` | `{ title, start_local, end_local, timezone, attendees?, video_call_request_id?, booking_id? } -> { status, external_event_id?, html_link?, video_link? }` | Needs `calendar-account`. |
| `tool:move-a-booking-on-my-calendar`, `tool:cancel-a-booking-on-my-calendar` | `{ event_id, start, end }`, `{ event_id }` -> `{ status }` | Need `calendar-account`. |
| `tool:make-a-calendar-invite` | `{ uid, start, end, summary, organizer, attendees?, method?, sequence? } -> { filename, text }` | Sends nothing. |

## Dependencies

**Depends on:** `tools/records-door` (packed by every row at `/opt/records-door`). Node 24 in the tool container runs the `.ts` files by stripping their types.

**Depended on by:** Trillion's deploy reads `tool-rows.json`.
