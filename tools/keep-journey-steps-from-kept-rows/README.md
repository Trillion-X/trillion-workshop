# tool:keep-journey-steps-from-kept-rows

Keeps a pursuit's kept rows (bookings from `statements`, sales from `payment_events`) as its journey steps, and removes the proof rows that are old enough. The mappings are in `read-data/journey-kept-rows.json`; the kit's schema is applied from `traffic-attribution/read-data/journey-steps.sql`.

## Wakes

A wake is a row in the tool's `wakes` list (`tool-rows.json`). The engine accepts only the keys its wake declaration has (`id`, `on`, `budget`, `input`, `until`, `retry`, `skip_unchanged`, `rate`, `replay`, `needs_input`, `on_failure`); a wake with any other key is left out and logged as `unknown_setting`.

- **keep-steps-when-bookings-change** (`needs_input`: `credential_name`). A row changed in `statements` of the database named by `credential_name`. The row-changes waiter (`notice-when-something-shows-up`) tells it as `something-changed`. Reads the new rows and keeps their steps once.
- **keep-steps-when-payments-change** (`needs_input`: `credential_name`). A row changed in `payment_events` of the database named by `credential_name`, told the same way. Reads the new rows and keeps their steps once.
- **keep-steps-every-fifteen-minutes** (`needs_input`: `credential_name`). A slow fallback every 15 minutes, so a missed row-change notice still gets its steps kept.

## Proof rows

Each run also removes proof steps (and proof touches) older than `proof.purge_after_hours` in `traffic-attribution/read-data/journey.json`. See `purgeProofRows` in `traffic-attribution/do-work/journey.mjs`.
