# tidycal

The Workshop rows for TidyCal (tidycal.com): one http row per TidyCal call. Each row sends the person's TidyCal key from the vault (`tidycal-api-token`) as a bearer header, to tidycal.com only.

| File | Purpose |
|---|---|
| `tool-rows.json` | The http rows the engine runs (no code of their own). |
| `test/tidycal-rows.test.mjs` | Checks that every row holds only `tidycal-api-token`, sent to tidycal.com as a bearer header. |

Rows read the booking types (`tool:list-my-tidycal-booking-types`, which carry each booking page's address) and the bookings (`tool:list-my-tidycal-bookings`). Routes are verified only by a live call; the row's `provenance.verified_live` says whether one was made.
