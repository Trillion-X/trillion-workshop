# customer-support / show

The React render + mount layer for the Support Workbench: blind, data-driven renderers that turn a `CustomerSupportWorkspace` projection into a workbench screen, plus the single mount boundary where transport and action dispatch live.

## Files

| File | Purpose |
|------|---------|
| `mount-customer-support.tsx` | The mount boundary (entry). Reads the live `record-work` value via `useBitfieldData`, maps it with `inputFromLiveValue`, renders `CustomerSupportSurface` inside the shared floating frame + error boundary, and dispatches owner actions through `sendRequestToBitfieldTarget`. The ONLY place transport lives. |
| `CustomerSupportSurface.tsx` | The top-level blind surface. Composes header (title + count + view switch), issue banner, collection, detail, and the mobile detail-push from workspace DATA. Carries zero domain vocabulary — all labels come from the copy map. |
| `record-collection.tsx` | The list/grid of work records for the active view (`RecordCollection`). |
| `record-detail.tsx` | The selected-record detail pane (`RecordDetail`): fields, evidence, and the record's own actions. |
| `record-field-list.tsx` | Renders a view's ordered fields against a record's values (`RecordFieldList`). |
| `field-value-view.tsx` | Renders one field value (`FieldValueView`) and the state badges (`StatusBadges`) from generic state refs. |
| `source-inbox.tsx` | The upstream-activity rail (`SourceInbox`): one inbox item per record's owner evidence. |
| `action-composer.tsx` | The inline composer (`ActionComposer`) for actions that need typed answers (e.g. a reply body). |
| `issue-banner.tsx` | The calm recoverable-issue banner (`IssueBanner`): translates raw `category:detail` issue strings to DATA-driven human copy, one row per category. |
| `humanize.ts` | Show-layer ref translation: turns internal tokens/origins into human words (`humanizeToken`, `humanizeOrigin`). |
| `workspace-types.ts` | The canonical `SupportRecord` alias, derived from the workspace projection so renderers can't drift (SSOT). |
| `fixtures.ts` | Test-only render-state DATA (empty/sparse/dense/issue + two non-support domains proving genericity). Never seeded into live state (L117). |
| `customer-support-surface.test.tsx` | The render-state matrix + live-dispatch + real cell_table row-array delivery proof. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `mount` (default) | `({ el, props }) => ReactRoot` | Package entry: mounts the workbench into a host element. |
| `CustomerSupportPanel` | `() => React.ReactElement` | Reads live `record-work`, builds the workspace, wires action dispatch. |
| `inputFromLiveValue` | `(value: unknown) => RecordWorkGraphInput & { status? }` | Maps the live value into reader input. Accepts the live `cell_table` row-array `Array<{address, payload}>` OR an explicit-array object shape. |
| `CustomerSupportSurface` | `(props: CustomerSupportSurfaceProps) => ReactElement` | The blind top-level surface. |
| `CustomerSupportSurfaceProps` | `{ workspace, layout?, loading?, errorMessage?, onAction? }` | Surface inputs — workspace DATA + state hints + action callback. |
| `SupportActionHandler` | `(action, record \| undefined, answers) => void` | The owner-action callback shape the surface emits. |
| `SupportRecord` | `CustomerSupportWorkspace['records'][number]` | Decorated record (fields + evidence + actions) every renderer consumes. |
| `RecordCollection` / `RecordDetail` / `RecordFieldList` / `SourceInbox` / `ActionComposer` / `IssueBanner` | `(props) => ReactElement \| null` | The composed sub-renderers, all blind to domain vocabulary. |
| `FieldValueView` / `StatusBadges` | `(props) => ReactElement \| null` | Leaf value + state-ref renderers. |
| `translateIssues` | `(issues: string[], copy) => TranslatedIssue[]` | Collapses raw `category:detail` issues into per-category human copy. |
| `humanizeToken` / `humanizeOrigin` | `(raw) => string` | Internal-token → human-word translation. |

## Dependencies

**Depends on:**
- `@/packages/ui` — shared UI atoms/molecules (`Container`, `Text`, `Badge`, `SegmentedControl`, `FloatingMaterialFrame`, `ErrorBoundary`, `SafeErrorCard`, `SeverityRow`, `mountReactSurface`). No raw HTML or `className` (L065).
- `@bitfield/runtime-kit` (`sendRequestToBitfieldTarget`) and `@bitfield/runtime-kit/react` (`useBitfieldData`) — transport + live-value read, used ONLY in `mount-customer-support.tsx`.
- `../read-data/read-customer-support-workspace` (`readCustomerSupportWorkspace`, `CustomerSupportWorkspace`) — the projection that decorates records.
- `../read-data/record-work-graph` (`RecordWorkGraphInput`, `WorkDescriptor`) — the generic decoder types.
- `../do-work/invoke-customer-support-action` + `../do-work/invoke-record-work-action` (`ActionDescriptor`) — action invocation boundary.

**Depended on by:**
- The package entry record `package::customer-support::entry::customer-support` (`source_path: show/mount-customer-support.tsx`) in `../things-to-store-and-run.json`.

## Architecture Notes

- **Generic / Data-Driven Gate (L063/L090):** every field, status, view, action, and copy line is DATA carried by a published record. A new one appears by adding ONE published-record row to `../things-to-store-and-run.json` (it flows into the `record_from_matching_records` aggregate and the decoder buckets it by `payload.kind`) — ZERO renderer edits. No closed status union, no domain term, no business outcome in any `.tsx`.
- **Blind renderers:** every file except `mount-customer-support.tsx` is pure and free of browser globals and transport — safe to reuse under iOS JSCore.
- **Honest states (L117):** empty/loading/error render honest states; nothing is fabricated. `fixtures.ts` is test-only and never seeded live.
- **Live delivery:** the live `record-work` value is the `package::customer-support::published-records` `cell_table` aggregate, projected `op: rows` into `Array<{address, payload}>`; `inputFromLiveValue`'s array branch + the decoder bucket those rows by kind. The matrix test feeds this exact shape to avoid vacuous-green.
