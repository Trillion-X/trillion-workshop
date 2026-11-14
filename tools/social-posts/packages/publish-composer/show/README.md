# publish-composer / show

The package-owned React surface for writing a post and handing off a publish intent — pure surface plus production mount.

## Files

| File | Purpose |
|------|---------|
| `PublishComposer.tsx` | Pure surface. Takes `surface: PublishComposerSurfaceView \| null` (null = loading) and renders the full Mobbin composer-first anatomy. Owns only ephemeral draft state (title/body) and the post lifecycle (`idle/posting/queued/failed`). Zero `className`, zero raw DOM — composed entirely from shared `ui`/`screen-look` primitives. |
| `mount-publish-composer.tsx` | Production entry. `PublishComposerPanel` calls `useBitfieldData('contentDistributionEvidence')` → `readPublishComposerSurfaceView(rows)` → `<PublishComposer>`, wrapped in `FloatingMaterialFrame` + `ErrorBoundary`. `export default mount({ el, props })`. |
| `publish-composer-fixtures.ts` | Render-state fixtures (`PUBLISH_COMPOSER_LOADING`, `publishComposerFixtures.{empty,blocked,sparse,dense,notReady}`) shared by the surface test and the visual-proof harness — the states tested are exactly the states screenshotted. |
| `PublishComposer.test.tsx` | jsdom render-state matrix + posted/failed request assertions + banned-vocabulary + custom-named-generic tests. |

## Key Types

| Type / fn | Shape / signature | Role |
|---|---|---|
| `PublishComposerProps` | `{ surface: PublishComposerSurfaceView \| null }` | Sole input; `null` renders the loading placeholder |
| `AttemptPhase` | `'idle' \| 'posting' \| 'queued' \| 'failed'` | Local post lifecycle (not data-drivable; driven by the submit boundary) |
| `ATTEMPT_VOCAB` | `StatusOverrides` | Data-driven status label/tone map (`posting`→info, `queued`→success/terminal) — no closed status enum branched in JSX |
| `PublishComposer` | `(props) => JSX` | Pure surface |
| `default` (mount) | `({ el, props }) => void` | Host mount entry |

## Architecture

Pure-surface + mount-wrapper pattern (CRM/calendar convention): the surface is fixture-testable
in isolation; `useBitfieldData` lives only in the inner `*Panel` inside the mount wrapper. One
code path renders React DOM and iOS JSCore; responsive split is `ResponsiveSwitch` (pure CSS) —
no `window.*`, no separate mobile component. The composer is BLIND: it consumes translated
destination fragments and emits a descriptor-free intent by id; it never sees execution/transport
data (enforced by `tests/publish-composer-boundary.test.ts`).

## Dependencies

- **Depends on:** `@/components/ui` barrel (Card, Button, StatusDot, Dropdown, EmptyPlaceholder,
  SafeErrorCard, OutputFieldList, ResponsiveSwitch, FloatingMaterialFrame, ErrorBoundary, …);
  `read-data/read-publish-composer.ts`; `do-work/submit-publication.ts`;
  `@bitfield/runtime-kit/react`.
- **Depended on by:** the studio app surface registry; the visual-proof harness
  (`../proof/harness/`) imports the pure `PublishComposer` and the fixtures.
