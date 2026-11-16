# Reference-Grounded Screen Contract: Content Analytics

## Live Package Truth

- Package set: `example-school-of-tennis`
- Package: `content-analytics`
- Live authority: selected Example app log; package-set owner-log admission is closed by the 90-package repair packet.
- Boundary file: `/workspace/the-owner/dev/bitfield-packages/packages/content-analytics/things-to-store-and-run.json`

## Human Job

- Primary job: see how content performed and connect results back to the product/customer loop.
- Dominant action: inspect a result or record an analytics observation.

## Capability Inventory

- Real capabilities to expose: analytics source, observation, publish-status observation, accepted snapshot, and content result surface.
- Hidden capabilities: package records, raw metric payloads, source fingerprints, workflow internals, provider transport, and customer/contact truth.

## Reference Inventory

- Contract references: `/workspace/the-owner/dev/ai-command-center/notes/projects/packages-and-package-sets/tennis-chess/reference/2026-06-20-tennis-product-constellation-mobbin-reference-contract.md`
- Mobbin seed references:
  - Twitch web updated poll percentages: `https://mobbin.com/screens/a47d5347-dbfb-4356-80fa-659ce862a041`
  - Circle web detailed leaderboard: `https://mobbin.com/screens/cd5daccd-6265-486c-be44-b4c182c6c4f0`
  - Paramount+ iOS media detail screen: `https://mobbin.com/screens/cf3a75a1-d733-4bf9-9b72-8568ba87eb28`
  - Vanta SLA list: `https://mobbin.com/screens/631da5b7-7729-472a-8169-5a80dce56bd1`
- Tool/MCP references: Claude frontend agents still owe refreshed Mobbin MCP screenshots in `/workspace/the-owner/dev/bitfield-packages/packages/content-analytics/proof/mobbin-reference-proof.md`.

## Reference Anatomy

- Layout: result summary cards, content list, selected content detail, metric rows, and status/observation timeline.
- Density: top result summary and selected item dominate.
- Typography: content title and main result are primary; metric/source details are compact.
- Surfaces: metric cards, content rows, result bars, status timeline, and observation form.
- Motion: metric update and selected-row transition belong to the Mobbin-proofed UI wave.
- States: empty, sparse, dense, loading, error, no observations, mobile, and desktop.
- Mobile/desktop: mobile stacks summary, list, detail; desktop can split list and detail.

## Translation Boundary

- Banned primary UI terms: package, workflow, slot, envelope, payload, fingerprint, raw metric payload, source path, runtime, debug, MCP, Mobbin, proof, and acceptance criteria.
- Human terms: content result, views, watch time, click, lead, customer, product, source, and trend.
- Data-to-control mapping: observation records become metric rows; publish-status observations become status timeline; accepted snapshots become result summaries.

## Shared Primitive Plan

- Reuse `ui` cards, tables/lists, tabs, status badges, charts/bars, empty, loading, and error primitives.
- Reuse `screen-look` spacing, type, state color, focus, and responsive layout.
- Elevate reusable `MetricSummaryCard`, `ContentResultRow`, and `ObservationTimeline` primitives after screenshot proof.

## Render-State Matrix

- Empty: no observations.
- Sparse: one content result and one observation.
- Dense: many content rows remain scannable.
- Loading: summary/list/detail keep stable dimensions.
- Error: human-readable observation error.
- Mobile: summary first, list then detail.
- Desktop: summary, list, and detail can coexist.

## Visual Proof

- Capture path: `/workspace/the-owner/dev/bitfield-packages/packages/content-analytics/proof/visual-proof.md`
- Acceptance checks: result summary renders, selected content detail renders, observation/status timeline renders, backend terms absent from default UI.
