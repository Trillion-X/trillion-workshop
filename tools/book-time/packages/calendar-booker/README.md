# calendar-booker

`calendar-booker` owns generic scheduling and booking package data. The CS-285
booking-links product capability is expressed here as owner-action surface data;
there is no separate `booking-links` package root or slot.

## Backend Contract

- `things-to-store-and-run.json` declares record schemas, workflow actions,
  owner-action descriptors, readiness/rule descriptors, and exact projection
  descriptor addresses.
- `read-data/read-calendar-booker-work-graph.ts` folds supplied descriptor,
  current-record, and receipt rows into a renderer-neutral work graph. It has no
  network, browser, workflow, or local-storage side effects.
- `do-work/publish-availability-policy.ts` sends availability setup through the
  generic owner-action descriptor invocation helper.
- `show/CalendarBookerSurface.tsx` and `show/CalendarAvailabilitySetupSurface.tsx`
  render the descriptor-backed work graph. The old demo/local active truth,
  generated sample times, local status enum, and local confirmation/cancel
  mutations are removed from the active mount path.
- `show-ios-jscore/mount-calendar-booker-jscore.js` renders the same
  owner-translated descriptor payload under JavaScriptCore. The browser and iOS
  paths share descriptor bytes and action refs; native presses resolve through
  the same `owner_action_descriptor` rows before emitting sealed target invokes.
  It accepts both direct harness props and the Swift native screen-record
  `props` envelope.
- External account health and provider work remain with `service-connections`,
  `http-client`, and `process-session`.

## Proof

Focused backend proof:

```bash
node packages/calendar-booker/__tests__/booking-links-backend-boundary.test.mjs
npx vitest run --config ./vitest.config.ts packages/calendar-booker/do-work/publish-availability-policy.test.ts
npx vitest run --config ./vitest.config.ts packages/calendar-booker/read-data/__tests__/read-calendar-booker-work-graph.test.ts packages/calendar-booker/do-work/__tests__/calendar-booker-actions.test.ts packages/calendar-booker/show/__tests__/calendar-booker-surface.test.tsx
node packages/calendar-booker/show-ios-jscore/mount-calendar-booker-jscore.test.js
npx vitest run --config ./vitest.config.ts packages/calendar-booker/show-ios-jscore/mount-calendar-booker-jscore.test.ts
rg -n "calendar-booker-mobile|localStorage|fetch\\(|Google|Outlook|React|document\\.|window\\." packages/calendar-booker/show-ios-jscore --glob '!README.md' --glob '!*.test.js' --glob '!*.test.ts'
node -e "const fs=require('fs'); JSON.parse(fs.readFileSync('packages/calendar-booker/things-to-store-and-run.json','utf8')); console.log('json ok')"
```
