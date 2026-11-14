# Reference-Grounded Screen Contract: Access-Scoped Content

## Live Package Truth

- Package set consumer: `tribes`; ethös supplies owner-ready access projections as DATA.
- Package boundary: `things-to-store-and-run.json`.
- Runtime authority: selected Tribes production log and CAS.
- Current source status: generic owner-surface implementation is green; live visual proof is open.

## Human Job

- Primary job: choose currently available content and use its real owner surface.
- Dominant action: open one available item.

## Capability Inventory

- Expose current availability, human title/summary, selection, revocation, and exact owner-rendered content.
- Hide grant refs, account hashes, access formulas, provider/MIME routing, package addresses, and decision revisions.

## Reference Inventory and Anatomy

- Product contract: `notes/projects/tribes/research/2026-07-29-ethos-community-composition-contract/REFERENCE-GROUNDED-SCREEN-CONTRACT.md`.
- Learning/library references: Coursera, Brilliant, Speak, and Skillshare captures in the learning-progress proof corpus; current rail anatomy was cross-checked on 2026-08-18 against Mobbin's [Whop course reader](https://mobbin.com/screens/ec7496bf-3b80-451f-9298-a9e68554eee4), [Babbel learning plan](https://mobbin.com/screens/a422a982-e18c-4b0a-9827-3edf3ddad400), [Codecademy learning list](https://mobbin.com/screens/2c023032-4345-4ff3-ab0d-98ee54730a0e), [Circle course content](https://mobbin.com/screens/afde5712-b2c0-4fc1-be7b-4ac42446d642), and [Magnific Academy](https://mobbin.com/screens/4b0d7119-a2fc-4ddc-8291-b3cacf949237).
- Anatomy: compact selectable rail plus one dominant content surface on desktop; rail precedes content in one column on mobile; unavailable state occupies the content frame without stale bytes.
- Rail state contract: search flows directly into a deliberately inset list with no decorative separator; the current lesson is communicated by a quiet filled background and `aria-current`, while keyboard focus keeps its own stronger focus ring; virtual rows retain their 72px cadence and the scroll container remains the owner of overflow.

## Translation Boundary

- Human terms: Library, available, not available, content title, summary.
- Banned terms: access decision ref/revision, package entry, renderer, target, MIME, provider, transcript, object store.
- Owner projection decides availability and supplies the exact render surface; source performs no entitlement or renderer inference.

## Shared Primitive Plan

- Reuse `PlaceableSurfaceHost` and `screen-look` CSS tokens for the selection/content frame.
- No media, transcript, entitlement, or provider primitive is duplicated here.

## Render-State Matrix

- Empty: honest “Nothing is available” state.
- Sparse/dense: one or many owner-ready rows with stable dominant content.
- Loading: no owner surface mounts before the projection resolves.
- Error/unknown renderer: human unavailable state.
- Revoked: current owner revision/availability update unmounts the surface immediately.
- Mobile/desktop: one-column then rail/content layout with reachable controls.

## Visual Proof

- Required capture: Tribes production at 390×844 and 1440×1000 for empty, sparse, dense, unknown-renderer, and live-revocation states.
- Render proof exists in `show/AccessScopedContent.renderer.test.tsx`; production screenshots remain a T7/T8/R6 gate.
