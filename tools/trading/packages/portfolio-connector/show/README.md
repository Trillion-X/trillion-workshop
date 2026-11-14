# portfolio-connector/show

Browser-local Account surface for the Trading Center — built ON the visual-database generic primitive (NOT bespoke trading components): a fey-grade, fully data-driven view of the account's value, balances, holdings, and guardrails.

## Files

| File | Purpose |
|------|---------|
| `PortfolioConnectorPanel.tsx` | The Account surface. Reads the live cycle + three visual-database descriptor DATA inputs via `useBitfieldData`, then renders generically: the hero (decoded `headline` — mono equity + today's change + a quiet `LineChart` equity line + daily-goal `Bar`), the balances strip (`RecordMetricRow` over metric descriptors), the holdings table (visual-database model → fey `Table`, columns + cells from descriptors via `FieldControl`), and the guardrails section. Premium honest empty/not-connected states; all numbers mono+tabular. ZERO hardcoded field/column set, zero domain enum literal. |
| `mount-portfolio-connector.tsx` | Entry mount — wraps the panel in `FloatingMaterialFrame` + `ErrorBoundary` and mounts it via `mountReactSurface`. |
| `README.md` | This file. |

## Key Types / Functions

| Function | Signature / Shape | Role |
|----------|-------------------|------|
| `PortfolioConnectorPanel` | `() => JSX.Element` | The Account surface. Reads `account-cycle` + `account-metrics` + `account-fields` + `account-views`; decodes the headline, projects the account record (balances) + position records (holdings) into visual-database models, and renders them through the shared generic primitives. Routes to the not-connected view when there is no live cycle. |
| `mount` (default) | `({ el, props }) => ReactSurfaceUnmount` | Package entry point referenced by `things-to-store-and-run.json` (`source_path: show/mount-portfolio-connector.tsx`). |

## Generic architecture (visual-database, mirrors trade-order)

- Hero = the account's INTRINSIC identity (the ONE total value + today's change every account has) from a decoded `AccountHeadline` + `LineChart` + goal `Bar`. Named accessors are correct for intrinsic identity.
- Balances = `RecordMetricRow` over METRIC DESCRIPTORS (DATA at `account:board.metrics`). WHICH figures + label/format/tone/order are data; `formatAccountMetric` formats by `descriptor.shape`, no field-id branching.
- Holdings = the visual-database model rendered as a fey `Table`: columns = `model.fields.filter(f => !STRUCTURAL_ROLES.has(f.role))` (DATA at `account:board.fields`, discovered from position keys when absent); each cell via generic `FieldControl`; the title cell shows a `StatusDot` whose tone/pulse come from the shared `statusTone` helper (DATA).
- Status dot tone/pulse: the centralized visual-database `statusTone` helper — never a hardcoded status set.

## Render states

| State | What shows |
|-------|------------|
| Live + holdings | headline equity + today's change + equity line + goal bar; `RecordMetricRow` balances; a fey holdings table (columns from descriptors); guardrails |
| Live + flat (today) | headline + 0% day; balances; premium "no positions yet today, N orders queued for the open" empty state; guardrails |
| Genuinely not connected | "Connect a broker account" card (only when no live cycle at all) + guardrails |

## The generic test

Point this exact file at a Schwab account, an options portfolio, or a futures account by authoring different descriptor records (and the broker reporting its own fields) — ZERO change here. No fixed field set, no fixed column set, no state enum literal in this file.

## Dependencies

**Depends on:** `@/packages/ui` (Badge, Bar, Button, Card, Container, EmptyPlaceholder, Icon, LineChart, ScrollableSurface, StatusDot, Table family, Text, `emitPlaceableSurfaceIntent`, `FloatingMaterialFrame`, `ErrorBoundary`, `mountReactSurface`); `@/packages/visual-database` (`decodeVisualDatabaseModel`, `recordsForView`, `FieldControl`, `displayTitle`, `statusTone`, `RecordMetricRow`); `@bitfield/runtime-kit/react` (`useBitfieldData`); `../read-data/account-board` (the translation boundary); `lucide-react` (icons).
**Depended on by:** the package entry (`things-to-store-and-run.json`) and, when placed, the trading workspace layout (`investment-command`).

## Invariants

- L065/L066: zero inline styling — all styling through `ui/` + visual-database component props, no raw HTML, no `className`.
- Generic / data-driven: the field set + columns + option domains are DATA. No instrument/account vocabulary, no hardcoded field/column list, no domain enum literal in this file (ML048).
- Honest data: never "Not connected" while a live cycle exists; never fabricated rows/history — absent facts render premium empty states.
- The panel reads + renders generically; the decoder (`account-board.ts`) translates. No raw `hold_reason` codes, OCC symbols, or lease/owner vocabulary reach the screen.
