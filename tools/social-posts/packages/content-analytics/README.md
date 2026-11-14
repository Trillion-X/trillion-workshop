# Content Analytics

Content Analytics owns package source for content performance records and
reporting projections.

## Files

- `things-to-store-and-run.json` declares capability, contracts, descriptor data, and workflow actions.
- `read-data/content-analytics-model.ts` translates evidence rows plus field/view/action/rule descriptors into the serializable surface model.
- `read-data/post-performance-attribution.ts` joins accepted published posts to provider observations by exact publish-status or remote-post identity, and to traffic by exact `utm_content` intent/post identity.
- `do-work/content-analytics-actions.ts` builds owner-action requests from descriptor data and selected model context.
- `do-work/read-provider-post-performance.ts` calls the declared workflow, which re-reads exact publish-status and source records, uses the source's DATA collection profile with the generic Service Connections read action, and persists only selected provider metrics/comments.
- `show/ContentAnalyticsPanel.tsx` renders the translated model and never parses backend-shaped records directly.
- `show-ios-jscore/content-analytics-jscore.js` renders the same serialized model into JSCore-compatible screen command JSON.
- `reference-grounded-screen-contract.md` locks the Mobbin-backed UI plan and render-state proof requirements.
- `proof/logic-backend-rebase-proof.md`, `proof/mobbin-reference-proof.md`, and `proof/visual-proof.md` track package proof gates.

## Boundary

This package does not own content publishing, customer relationship truth,
checkout/payment truth, or access truth. Customer lifecycle progress is tracked
by `customer-follow-up` from real customer step records.

Content Analytics is implemented as descriptor data over generic record,
projection, action, and rule primitives. Field labels, source roles, actions,
and blocker text are package data. The React and JSCore surfaces consume the
same serialized model; owner writes route through workflow action descriptors.

Post results copy metric maps from actual `content-analytics.observation` rows.
Attribution counts only captured traffic rows with a unique exact matching
`utm_content`, then follows visitor and project IDs to actual conversion rows.
Ambiguous post tokens and missing provider metrics, visits, conversions, or
conversion values remain absent rather than appearing as invented zeroes.
