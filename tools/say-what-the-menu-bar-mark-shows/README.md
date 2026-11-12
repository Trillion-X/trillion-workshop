# tools/say-what-the-menu-bar-mark-shows/

What the Mac menu bar item's mark says right now: how many things are running, the newest one and how far along it is, the unread count, or the next calendar line when nothing runs. The caller reads the person's records and unread count and hands them over; nothing is read, kept or drawn here.

Ported from the trillion-apps glance message in `web/src/workspace/alone-page.tsx` (commit `21a2de08`): the newest running record is "now", its numeric progress is rounded to two places, the list is the first eight running titles, and the next calendar line stands in when nothing runs. The countdown line comes from `tool:name-my-next-commitment`.

## Files

| File | Purpose |
|------|---------|
| `do-work/say-what-the-menu-bar-mark-shows.mjs` | `tool:say-what-the-menu-bar-mark-shows`: one JSON input on standard input, `{ result }` or `{ error }` on the last line. |
| `test/say-what-the-menu-bar-mark-shows.test.mjs` | Tests for the now line, the next line, the progress rounding, the eight titles and the refusals. |
| `tool-rows.json` | The Workshop row. |
| `part.json` | The entry the row runs is public. |

Not carried: the page's dedupe of the message (it tells the host only when the message changes) stays in the app, since it is the app's delivery.
