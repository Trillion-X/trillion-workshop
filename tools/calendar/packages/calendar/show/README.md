# Calendar React Surface

This folder owns the React/Desktop/Browser calendar surface for `calendar`. It
renders account visibility, calendar lists, the time grid, agenda, selected
details, conflict/offline states, and owner-backed actions from generic
time-block data.

Shared `ui` supplies primitive controls only. Calendar-specific account rails,
agenda rows, grid layout, detail panels, conflict treatment, and
data-to-human translation stay here.

Desktop and mobile command buttons must use the same owner-action descriptors.
When the live feed does not provide an owner descriptor, the button stays
disabled instead of inventing local calendar state.

Desktop view controls are real projections over the same `CalendarScreenModel`:
Day and Week render time grids, Month renders a month grid, and Agenda renders
a dense list. Event controls in every projection update the selected details
panel.

When a connected calendar account exists and the live time-block feed is empty,
`mount-calendar.tsx` asks the package workflow
`action:calendar.sync-google-events` to refresh data. The surface only sends
the connected account address; provider calls and credential handles stay in
workflow-owned package data and owner slots.

Connected Google Account rows stay visible as calendar-capable accounts even
when an older service-connection feed row has an empty `scopes` cell. The Google
Calendar workflow still enforces OAuth scope validity through `http-client`;
the UI model only keeps the verified account from disappearing.

Proof command from `/workspace/the-owner/dev/bitfield-packages`:

```bash
npx vitest run --config /workspace/the-owner/dev/bitfield-packages/vitest.config.ts /workspace/the-owner/dev/bitfield-packages/packages/calendar/show/__tests__/calendar-screen-model.test.ts /workspace/the-owner/dev/bitfield-packages/packages/calendar/show/__tests__/CalendarSurface.test.tsx
```

## W11 (2026-07-19) — lens enumeration + reference-locked anatomy

The live mount now ENUMERATES `time-block-lens` DATA rows (`read-data/read-calendar-lens-feeds.ts`): each lens carries its own self-describing engine read (`input.target` + `input.payload` + `rows_path`); rows project through the lens selectors into `CalendarTimeBlock`s and merge with the owner feed. Adding an event source = one lens DATA row, zero code. Per-lens read failure = a warning issue, never a dead surface.

Visual anatomy follows `reference/2026-07-19-w11-reference-lock-screen-contract.md`: the day/week grid is the shared `ui/hour-grid` primitive (hairlines, now-line, color-spine pills, Amie/Cron column packing supplied by `calendar-overlap-layout.ts`); month cells use color-dot mini-pills + "N more"; the detail panel envelope-mounts event notes via `PlaceableSurfaceHost` when `relations.notes` carries a `<package>/<entry>/<documentRef>` address (zero editor imports). The whole folder greps ZERO `className` — all styling through `ui` component props (L065).
