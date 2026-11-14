# Marketing Pipeline Browser Surface

This folder owns the React/Desktop/Browser mount for the Coordination Workbench:
one generic five-region surface that renders ANY `CoordinationSurfaceModel`.

The surface consumes `CoordinationSurfaceModel` from `read-data` and renders
field/view/action values from data. Package identity lives only in descriptor
data and `surfaceCopy` — never as renderer branches.

## Five Regions (plan §7.2)

1. **Source inbox** (`source-inbox.tsx`) — upstream connections feeding the records.
2. **Record collection** (`record-collection.tsx`) — data-driven arrangement (list/board/table) with a segmented control to switch saved views.
3. **Selected-record detail** (`record-detail.tsx`) — fields, connections, evidence, runs for the chosen record.
4. **Owner-action rail** (in `record-detail.tsx` via `actionsForRecord`) — the record's bound actions.
5. **Recoverable-issue banner** (`issue-banner.tsx`) — calm banner with a retry bound to the issue's `retryActionRef`.

Composed as a 3-pane desktop / stacked + full-screen-push mobile layout by
`MarketingPipelineSurface.tsx`.

## Files

| File | Purpose |
|------|---------|
| `MarketingPipelineSurface.tsx` | Composition root: header, the five regions, action/retry/select handlers, error/loading/empty early returns, mobile detail-push. |
| `mount-marketing-pipeline.tsx` | Browser mount entry — wires the surface to live runtime data. |
| `source-inbox.tsx` | Region 1: the upstream-connections column. Returns null when empty. |
| `record-collection.tsx` | Region 2: arrangement dispatch (`ARRANGEMENTS`), `GroupTable`, segmented view switch; status cells via `statusView`. |
| `record-detail.tsx` | Regions 3+4: `RecordDetail` plus `actionsForRecord`, connection/evidence/run lists, the action rail. |
| `issue-banner.tsx` | Region 5: stacked recoverable-issue cards with DATA-bound retry; `severityLevel` maps authored severity onto `SeverityRow` levels. |
| `coordination-field-list.tsx` | Renders a record's fields as label/value rows through `FieldValueView`. |
| `field-value-view.tsx` | One generic field-value renderer dispatched by `valueShape` (open dispatch + plain-text fallback, L090). |
| `humanize.ts` | Show-layer translation (L098): decodes raw tokens/origins into human copy. |
| `coordination-surface.test.tsx` | The render-state matrix: empty/loading/error/sparse/dense/view-switch/recoverable-issue/running/mobile/genericity/no-ref-leak/mount. |
| `README.md` | This file. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `MarketingPipelineSurface` | `(props: MarketingPipelineSurfaceProps) => ReactElement` | The composition root; default export. |
| `mountMarketingPipeline` | `(options?: MarketingPipelineMountOptions) => …` | Browser mount factory. |
| `SourceInbox` | `({ entries, selectedRecordId, onSelectRecord }) => ReactElement \| null` | Region 1. |
| `RecordCollection` | `({ model, view, selectedId, onSelect }) => ReactElement` | Region 2. |
| `RecordDetail` | `({ model, record, onActivate, onOpenEvidence }) => ReactElement` | Regions 3+4. |
| `actionsForRecord` | `(model, record) => CoordinationActionDescriptor[]` | Resolves a record's bound actions. |
| `IssueBanner` | `({ issues, resolveAction, onRetry }) => ReactElement \| null` | Region 5. |
| `CoordinationFieldList` | `({ fields, record }) => ReactElement \| null` | Field label/value rows. |
| `FieldValueView` | `({ valueShape, value }) => ReactElement` | Generic field-value dispatch (person/choice/text + fallback). |
| `valueToText` | `(value: unknown) => string` | Generic scalar → display string. |
| `humanizeToken` / `humanizeOrigin` | `(raw) => string` | Token/origin → human copy. |

## Dependencies

**Depends on:** `@/packages/ui` (the shared UI barrel — only import surface for atoms: `Container`, `Text`, `Badge`, `PersonTag`, `SafeErrorCard`, `SeverityRow`, `SegmentedControl`, `Table`, `statusView`, …), `../read-data` (`CoordinationSurfaceModel`, descriptor types, `groupRecords`, `inboxEntries`), `@bitfield/runtime-kit/react` (live data binding), `react`.

**Depended on by:** the package entry (`../.bitfield-entry-scope`) and the live studio package set; `../show-ios-jscore` mirrors this surface for JSCore.

## 2026-06-21 Proof Note

The React surface renders all five regions from `CoordinationSurfaceModel` with
title, empty state, empty action, running text, and fallback view text drawn
from `model.surfaceCopy`. No package-specific word is a renderer branch:
arrangement (list/board/table) dispatches through an open map with a `list`
fallback; status/severity render through data-driven `statusView` / a tolerant
severity map onto `SeverityRow`'s fixed levels; retry binds to the issue's
`retryActionRef`. Verified by the 12-case render-state matrix in
`coordination-surface.test.tsx`, including a `no-ref-leak` audit asserting
rendered text carries no `slot::`/`package::`/`coordination.`/ref vocabulary.
