# calendar-booker/do-work

Owner action request builders and the sole owner-translation feed for `calendar-booker`.

## Files

| File | Purpose |
|------|---------|
| `scheduling-offer-feed.ts` | The SOLE owner-translation boundary (L098). Reads the `display_label_descriptor` SSOT + projection-descriptor structure and emits already-human `ViewDescriptor[]` trees. The only place internal state keys → human status text/tone, action refs → button labels, and field keys → human field labels. |
| `invoke-owner-action-descriptor.ts` | Package-local generic target-request builder. Takes an owner action descriptor + input and sends the `execute_definition` request to the descriptor target, defaulting to `slot::workflow`. |
| `publish-availability-policy.ts` | Uses the descriptor path for availability setup. Creates no `booking-links` command family, provider worker, or new slot. |
| `calendar-booker-actions.ts` | Active package action boundary: resolves an opaque intent reference against `owner_action_descriptor` rows and builds the workflow-owner request — no booking records, status transitions, provider calls, or local IDs. |
| `derive-open-slots.ts` | Pure open-time derivation for one day: weekly wall-clock windows minus taken starts, busy intervals (widened by buffers) and the minimum-notice horizon. Declared public source; the Needle Mover Worker compiles it in. |
| `create-external-calendar-event.ts` | Puts a booking on the host's external calendar through a resolved connection (provider is DATA; Google today), with optional location, reminder minutes and a video call (`video_call`: Google makes a Meet call, `conferenceDataVersion=1`, and its link comes back as `video_link`; no call made is an error). Declared public source. |
| `external-calendar-busy-and-changes.ts` | The rest of a booking's life on that calendar: read busy intervals (`unknown` when unreadable, never a guessed "free"), move an event, cancel an event. Declared public source. |
| `calendar-invite-file.ts` | An iCalendar invitation (REQUEST or CANCEL) with the host as organizer, ported from bitfield.so's booking route; the route a booking takes onto the host's calendar when no connection is held. Declared public source. |
| `publish-availability-policy.test.ts` | Test for the publish-availability path (test-only). |
| `__tests__/` | Action boundary + feed contract tests (test-only). |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `buildSchedulingOfferView` | `(input: SchedulingOfferInput) => ViewDescriptor[]` | Builds one surface's owner-translated tree from a projection record + work graph + live records + optional status. |
| `indexDisplayLabels` | `(graph) => Map<string, DisplayLabelEntry>` | Indexes the 7 `display_label_descriptor` SSOT rows by state key. |
| `bookingStatusDescriptor` | `(stateKey, index, reason?) => StatusDescriptor` | State key → owner-translated status (text + tone from SSOT; unknown → neutral, no raw-key leak). |
| `translateActions` | `(actionRefs, disabledReasonByRef?) => ActionDescriptor[]` | Projection action refs → human button labels (never the internal `proof_label`). |
| `flattenViewLabels` | `(views) => string[]` | Collects every emitted human string — used by proof + ban tests. |
| `BANNED_LABEL_SUBSTRINGS` | `readonly string[]` | Substrings that must never appear in an emitted label (internal refs, engine vocabulary, raw keys). |
| `deriveOpenSlots` | `(input: DeriveOpenSlotsInput) => OpenSlot[]` | Open starts for one day; `{timezone, windows, dateISO, durationMin, stepMin, bufferBeforeMin?, bufferAfterMin?, minNoticeMin?, nowMs?, taken?, busy?}`. |
| `createExternalCalendarEvent` | `(connection, booking: BookingEventInput, fetch?) => Promise<{status, external_event_id?, html_link?, error?}>` | Creates the host's calendar event with attendees invited (`sendUpdates=all`). |
| `mintGoogleAccessToken` | `(connection, fetch) => Promise<string \| null>` | Exchanges the connection's refresh token for an access token. |
| `readExternalCalendarBusy` | `(connection, fromMs, toMs, fetch?) => Promise<{status: 'read' \| 'unknown', busy: Interval[], error?}>` | Host busy intervals from free/busy. |
| `moveExternalCalendarEvent` / `cancelExternalCalendarEvent` | `(connection, eventId, ...) => Promise<{status: 'changed' \| 'error', error?}>` | Move or cancel an event; attendees are told by the provider; an already-gone event counts as cancelled. |
| `calendarInviteFile` | `(input: CalendarInviteInput) => string` | `{uid, start_ms, end_ms, summary, description?, location?, organizer, attendees, method, sequence, now_ms, reminder_minutes?}` to an RFC 5545 file. |

## Dependencies

**Depends on:** `../read-data/read-calendar-booker-work-graph` (types: `AnyRecord`, `CalendarBookerWorkGraph`), `../show/view-descriptor` (descriptor types). Type-only imports — no runtime coupling to the renderer.

**Depended on by:** `needle-mover/src/booking.mjs` (the hosted Worker imports the four declared public sources above as library code), `../show` surfaces and mount entries render the `ViewDescriptor[]` this feed emits via `DescriptorSurface`. `calendar-booker-actions.ts` is consumed by the surfaces to route owner actions.

## Why This Design

This folder is the **translation boundary** (L098): all human labels/tones are produced here, so the downstream renderer can stay blind and the descriptor model can stay free of product vocabulary. Surface *structure* (which sources, which actions) comes from projection-descriptor DATA; this feed owns only *translation*, never structure.
