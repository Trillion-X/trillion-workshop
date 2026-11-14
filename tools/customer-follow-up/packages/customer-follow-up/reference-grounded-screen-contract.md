# Reference-Grounded Screen Contract: Customer Follow-Up

## Live Package Truth

- Package set: `ethos-school-of-tennis`
- Package: `customer-follow-up`
- Live authority: selected Ethos app log.
- Source boundary: `/workspace/the-owner/dev/bitfield-packages/packages/customer-follow-up/things-to-store-and-run.json`

## Human Job

- Primary job: know which customers are moving toward purchase, onboarding,
  follow-up, and feedback for each product.
- Dominant action: press `Record follow-up`.

## Capability Inventory

- Real capabilities to expose: customer targets, customer contacts, lifecycle
  steps, evidence refs, owner refs, purchase count, remaining count, timeline,
  and follow-up action.
- Hidden capabilities: workflow definition ids, source paths, package import
  mechanics, envelope addresses, raw rows, schemas, and slot routing.

## Reference Inventory

- Attio record detail: `https://mobbin.com/screens/d8d6c229-4909-490c-83a1-a84958f82b83`
- Intercom contact details: `https://mobbin.com/screens/5b30d930-1bf2-4ad8-91be-3f796fa08bdc`
- Intercom inbox email details: `https://mobbin.com/screens/2d121d98-b597-48ba-929a-8299f04c0431`
- Zendesk ticket list: `https://mobbin.com/screens/54ba55ac-8bb1-4273-8fcf-cb1ce6370de4`
- HubSpot web admin: `https://mobbin.com/screens/0c1e7ce4-e1d3-4bca-b416-3018938d2324`
- Apollo prospecting: `https://mobbin.com/screens/9b2f2a7a-8c9b-4eee-8851-d7f047e59331`
- Attio relationship workspace: `https://mobbin.com/screens/b9c21611-63dc-4d32-936b-6a756173b062`
- monday.com work board: `https://mobbin.com/screens/3e855c2d-29c8-4423-93ed-a1c308b9d0d6`
- Pipedrive pipeline: `https://mobbin.com/screens/2ff3c977-7902-48b5-8361-0c89710e5c2e`
- Pipedrive detail: `https://mobbin.com/screens/bb14ee04-5a09-488b-9b92-ab95e36860e0`
- Zendesk mobile ticket detail: `https://mobbin.com/screens/e12b4d44-0749-4b6d-a280-0620b3ece558`
- Intercom inbox: `https://mobbin.com/screens/88f64992-21fc-41e2-ae4a-4350c289a3c5`
- Intercom ticket details: `https://mobbin.com/screens/1135fde3-b0e4-4ab7-8654-7f99bc992a42`
- Vanta SLA list: `https://mobbin.com/screens/631da5b7-7729-472a-8169-5a80dce56bd1`
- incident.io progression: `https://mobbin.com/screens/beb49f89-6e5a-47e0-a02b-70665a3fe7bf`

## Reference Anatomy

- Layout: progress cards first, customer list on the left, selected timeline on
  the right for desktop; stacked progress, list, and selected timeline on mobile.
- Density: compact metrics and compact timelines, with one primary action.
- Typography: product and customer names carry the hierarchy; counts and times
  stay secondary.
- Surfaces: metric bands, list rows, and timeline rows use shared UI primitives.
- Motion: no package-local animation requirement.
- States: empty, sparse, dense, loading, error, mobile, desktop.

## Translation Boundary

- Banned primary UI terms: package, workflow, slot, envelope, payload, schema,
  raw row, source path, stored bytes, CRM owner record, engine write.
- Human terms: customers, targets, follow-up, purchase, onboarding, feedback,
  timeline, remaining, progress.
- Data-to-control mapping: product targets become progress cards; contacts
  become selectable rows; steps become timeline rows; primary action writes one
  follow-up step for the selected customer and product.

## Shared Primitive Plan

- Reuse `ui` buttons, containers, text, progress, empty, loading, and safe error
  primitives.
- Reuse `screen-look` spacing, type, state color, focus, and responsive layout.
- Elevate reusable `CustomerProgressBand`, `CustomerTimeline`, and
  `CustomerSelector` primitives after screenshot proof.

## Render-State Matrix

- Empty: no customer targets and no customers.
- Sparse: one product target, one customer, one or two steps.
- Dense: many customers and many steps remain scannable.
- Loading: shared shell loading state.
- Error: shared safe error state.
- Mobile: stacked target/list/detail hierarchy.
- Desktop: progress band above split list/detail.

## Visual Proof

- Capture path: `/workspace/the-owner/dev/bitfield-packages/packages/customer-follow-up/proof/visual-proof.md`
- Acceptance checks: exact Mobbin reference mapping exists, no backend terms in
  primary visible copy, selected customer action dispatches owner action, and no
  fake customer rows are used as production proof.
