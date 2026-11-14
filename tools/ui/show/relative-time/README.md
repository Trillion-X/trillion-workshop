# ui/show/relative-time — a moment in plain words

The one owner of how a moment reads on a screen, so every screen says the same moment the same way.

## Files

| File | Purpose |
|------|---------|
| `relative-time.ts` | `relativeWhen` and `relativeDay` (when something happened: "5 min ago", "Yesterday"), `relativeDate` (a day ahead or behind now, for planning: "Tomorrow", "Tue 3:00 PM"), `momentInWords` and `stretchInWords` ("Tue, 14 Oct, 3:01 AM"; a span on one day shares its date). Never seconds; a time that is not a date says an empty string. |

## Dependencies

**Depends on:** `Date` and `Intl` only.
**Depended on by:** the shared record view (`relativeDates` on a date field, used by the task tray), posts, rows and notices that say when something happened, and the meeting note's date rows.
