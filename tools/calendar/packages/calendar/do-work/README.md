# Calendar Do Work

This folder owns browser-side request builders for Calendar owner workflows.
It does not call providers directly and does not read or store secrets.

`sync-google-calendar.ts` asks `slot::workflow` to run
`action:calendar.sync-google-events`. That workflow owns the Google Calendar
feed refresh definition and composes `credentials-vault`, `http-client`, and
Calendar normalization to write `calendar-time-block-owner-feed`.

