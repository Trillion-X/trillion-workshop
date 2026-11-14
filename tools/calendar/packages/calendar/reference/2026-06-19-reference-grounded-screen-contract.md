# Reference-Grounded Screen Contract: calendar

## Live Package Truth
- Package set: `bitfield-studio`
- Package: `calendar`
- Source root: `/workspace/the-owner/dev/bitfield-packages/packages/calendar/`
- Boundary file: `/workspace/the-owner/dev/bitfield-packages/packages/calendar/things-to-store-and-run.json`

## Human Job
- Primary job: scan connected calendars, select events, inspect details, and initiate calendar actions without losing the current range.
- Dominant action: switch the calendar view and click an event to inspect or act on it.

## Capability Inventory
- Real capabilities to expose: connected account rail, calendar visibility, day/week/month/agenda views, selected event details, all-day items, timed items, sync/empty/error states, booking/new-event/search owner actions, conflict/offline blocks.
- Hidden capabilities: credential handles, provider HTTP transport, workflow execution internals, package admission, raw event identifiers.

## Reference Inventory
- Google Calendar and Apple Calendar desktop: toolbar range controls, segmented view switcher, clickable event chips, right-side detail/inspector.
- Linear-style issue side panels: selected item remains stable while the list/grid changes behind it.
- Local reference screenshots from the current live Bitfield Studio bug report show Week grid, details panel, and inert view controls.

## Reference Anatomy
- Layout: desktop three zones: account rail, view body, selected details. Mobile uses agenda plus bottom detail sheet.
- Density: compact toolbar and dense event chips; details panel uses stronger event title and quieter metadata.
- Typography: event title is the scan anchor; status and range text are secondary.
- Surfaces: selected event has a visible focus ring in grids/lists; agenda/month rows use button semantics.
- Motion: view switching keeps selected event when possible and selects the first visible block when needed.
- States: empty, sparse, dense, loading, error, offline, conflict, mobile, desktop.
- Mobile/desktop: the same `CalendarScreenModel` drives all views; mobile defaults to agenda.

## Translation Boundary
- Banned backend terms: package, package-set, envelope, payload, slot, descriptor, handler, runtime, source path, raw id, workflow_steps.
- Human terms: calendars, account, event, all day, day, week, month, agenda, details, saved, waiting to sync, conflict.
- Data-to-control mapping: `CalendarTimeBlock` rows become selectable event controls; owner action descriptors become buttons; `viewMode` chooses the body projection.

## Shared Primitive Plan
- Reuse: `Button`, `Badge`, `Container`, `SegmentedControl`, `Text`, `Divider`, `Spinner`.
- Elevate: no shared primitive change in this repair; view-specific calendar layouts stay package-owned.

## Render-State Matrix
- Empty: no account and connected-empty.
- Sparse: one or few events.
- Dense: overlapping and many events.
- Loading: sync in progress visible without replacing the surface.
- Error: account/feed issue visible beside the work surface.
- Mobile: agenda plus detail sheet.
- Desktop: day/week/month/agenda plus detail panel.

## Visual Proof
- Capture path: live `bitfield-studio` opened through `open-bitfield-app bitfield-studio`.
- Acceptance checks: event buttons update the details panel; Day/Week/Month/Agenda render distinct bodies; selected event is visually marked; no backend terms are visible.
