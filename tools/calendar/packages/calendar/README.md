# Calendar Package

`calendar` owns the generic time-block projection and owner-action handoff used by calendar surfaces.

It reads finished owner-fed rows through `time-block-lens` records, projects them into stable `CalendarTimeBlock` records, and sends user intent as data-described owner-action descriptors. It also owns the Calendar feed refresh workflow definition that composes `credentials-vault`, `http-client`, and package-owned normalization to write `calendar-time-block-owner-feed`. It does not own account connection lifecycle, secret material, outbound network execution, public booking rules, task truth, audio-note task truth, multi-step action execution, or raw provider transport execution.

Calendar consumes the public `service-connections` feed to derive visible
connected calendar accounts. That feed is an addressed input contract, not a
TypeScript import from the Outside Accounts and Keys package and not secret material.
When a connected Google Account is visible and the time-block feed is empty,
the browser surface asks `action:calendar.sync-google-events` to refresh the
feed. The action reads an opaque credential handle from `credentials-vault`,
calls Google Calendar through `slot::http-client`, normalizes the returned
events into generic Calendar blocks, and writes the package-owned feed address.

## Source Boundary

- Source workshop: `/workspace/the-owner/dev/bitfield-packages/packages/calendar`
- Boundary file: `things-to-store-and-run.json`
- Entry map: `entry-to-package-data-map.json`
- Browser material entry: `show/mount-calendar.tsx`

Runtime Kit package-set folders are package admission/cache evidence, not source truth for this package.

The main workspace picker discovers Calendar through
`package::calendar::published-record::placeable-surface::calendar`. The surface
stays package-owned; shared `ui` supplies primitive visual controls only.
The package also declares the generic aggregate feed
`package::calendar::published-records` with `record_from_matching_records`; the
picker reads that feed, so publishing only the individual placeable-surface
record is not enough.

## Backend Proof Commands

Run from `/workspace/the-owner/dev/bitfield-packages`:

```bash
npx vitest run packages/calendar
rg -n "from ['\\\"].*(service-connections|calendar-booker|tasks|workflow|credentials-vault|http-client)|google|outlook|gmail|calendly|crm" packages/calendar --glob '*.{ts,tsx,js,jsx}'
```

## Proof Log

- 2026-06-16 15:23 CDT: `npx vitest run packages/calendar` passed: 4 test files, 10 tests.
- 2026-06-16 15:24 CDT: boundary grep returned no matches:
  `rg -n "from ['\\\"].*(service-connections|calendar-booker|tasks|workflow|credentials-vault|http-client)|google|outlook|gmail|calendly|crm" packages/calendar --glob '*.{ts,tsx,js,jsx}'`.
- 2026-06-16 15:25 CDT: `npm run write:package-live -- --package calendar --live-log-only` wrote 12 package records and `package::calendar::entry-bytes::calendar` to the live `bitfield-studio` log at `http://127.0.0.1:3012`; entry bytes hash `1f:85fdb719a0b2339a7c3af2c23aaa659410f5d93400fabceb59cc93fb231b612e`.
- Durable `make-package-current` is blocked by an unrelated existing `browser-shell` build-profile failure in the app-log-storage copy: missing `scripts/build-package-entry-byte.mjs`.
- 2026-06-16 23:20 CDT: added
  `package::calendar::published-record::placeable-surface::calendar` and replaced
  the blank mount with a visible package-owned material shell.
- 2026-06-18 01:35 CDT: React/Desktop Calendar surface proof passed:
  `npx vitest run --config /workspace/the-owner/dev/bitfield-packages/vitest.config.ts /workspace/the-owner/dev/bitfield-packages/packages/calendar/show/__tests__/calendar-screen-model.test.ts /workspace/the-owner/dev/bitfield-packages/packages/calendar/show/__tests__/CalendarSurface.test.tsx`.
- 2026-06-18 02:10 CDT: live log proof found the individual Calendar surface
  and entry bytes present, then repaired the missing
  `package::calendar::published-records` aggregate feed through
  `engine.operation.write-batch`.
- 2026-06-18 08:48 CDT: repaired the Calendar live-read input contract after
  the browser material reported `live package read scope is missing
  package::calendar::input::time-blocks` and then `Bitfield read scope has no
  default input`. The package input descriptor now has label-readable package
  metadata, `is_default: true`, and `value.source_bytes.bytes_to_value: json`.
  Source, Runtime Kit mirror evidence, and the live `bitfield-studio` log were
  updated through `engine.operation.write-batch`. Focused proof passed:
  `npx vitest run --config /workspace/the-owner/dev/bitfield-packages/vitest.config.ts /workspace/the-owner/dev/bitfield-packages/packages/calendar/read-data/__tests__/calendar-package-contract.test.ts /workspace/the-owner/dev/bitfield-packages/packages/calendar/show/__tests__/calendar-screen-model.test.ts /workspace/the-owner/dev/bitfield-packages/packages/calendar/show/__tests__/CalendarSurface.test.tsx`
  and `node --test /workspace/the-owner/dev/bitfield-runtime-kit/references/background-runner-shell/scripts/write-package-live.test.mjs`.
  Browser proof in a fresh Studio tab at `http://127.0.0.1:3012/src/index.html`
  opened Calendar with zero console errors and rendered the empty Calendar week
  view instead of the `calendar material` error boundary.
- 2026-06-19 CDT: added the package-owned Google Calendar feed refresh action
  `action:calendar.sync-google-events` plus the browser-side empty-feed trigger.
  The workflow composes `credentials-vault` and `http-client`, then writes the
  generic `calendar-time-block-owner-feed`; raw tokens and provider transport
  remain outside Calendar ownership.
- 2026-06-19 CDT: corrected the Google Calendar refresh action to write
  `calendar-time-block-owner-feed` as JSON bytes through `payload_bytes`; the
  `time-blocks` input consumes `bytes_to_value: json`, so structured `payload`
  writes do not satisfy the live feed contract.
- 2026-06-19 CDT: normalized every workflow `steps` binding to the resolver's
  canonical `select.key` plus string `select.path` shape and added a contract
  test that rejects nested `select.path` objects. Live proof after import:
  `action:calendar.sync-google-events` completed with Google Calendar
  `http_status: 200`, `event_count: 20`, and `calendar-time-block-owner-feed`
  contained 20 blocks, 0 issues, and `status: synced`.
- 2026-06-19 CDT: added the Reference-Grounded Screen Contract for Calendar
  interaction repair, moved the desktop body to real day/week/month/agenda
  projections, and made grid/month/agenda events update the selected details
  panel. Focused proof passed:
  `npx vitest run --config /workspace/the-owner/dev/bitfield-packages/vitest.config.ts /workspace/the-owner/dev/bitfield-packages/packages/calendar/show/__tests__/calendar-screen-model.test.ts /workspace/the-owner/dev/bitfield-packages/packages/calendar/show/__tests__/CalendarSurface.test.tsx`
  plus Calendar read-data contract tests.
- 2026-06-19 CDT: Google Calendar sync stopped reading a stored
  `oauth_access_token`. The workflow now mints handles for the Google Account
  OAuth Client ID, OAuth Client Secret, and Refresh Token, then asks
  `http-client` to perform OAuth2 refresh-token authorization internally before
  the Calendar API call.
- 2026-06-19 CDT: corrected Google Calendar sync scope validation so Calendar
  requests require Calendar-readable scopes only, not Gmail scopes from the
  shared Google Account connection.
