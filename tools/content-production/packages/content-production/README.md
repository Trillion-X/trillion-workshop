# Content Production

Content Production owns package source for turning source material into
derived content drafts and production-ready content artifacts.

## Files

- `things-to-store-and-run.json` declares capability, surfaces, contracts, run profiles, recipes, and workflow actions.
- `read-data/` builds workspace, library, style, and deliverable views.
- `do-work/` owns content-production run helpers and media recipe utilities.
- `show/` renders workspace, library, style, deliverables, and production surfaces.
- `reference-grounded-screen-contract.md` locks the Mobbin-backed UI plan and render-state proof requirements.
- `proof/mobbin-reference-proof.md` and `proof/visual-proof.md` track the still-open screenshot proof gates.

## Boundary

This package does not own customer relationship truth, product access truth,
distribution-account authority, or analytics truth. Customer lifecycle progress
is tracked by `customer-follow-up`; distribution and analytics remain with
their owner packages.

## Backend Loop Proof

The source backend proof for the idea-to-content leg is structural and
executable:

- `action:submit-content-production-run` writes production run/status records.
- Production execution/output is invoked as a separate owner action after the
  run is accepted; submit does not synchronously re-enter workflow execution.
- `action:content-production-prompt-to-publish-intent` builds a
  `content-distribution.publish-intent`.
- `action:pipeline-record-to-publish` keeps record-to-publish automation off
  until a data write enables it.
- The package writes no contacts, purchases, access grants, customer rows, or
  product usage rows.

Run from `/workspace/the-owner/dev/bitfield-packages`:

```bash
node packages/content-production/__tests__/record-to-publish.test.mjs
node packages/content-production/__tests__/capability-delivery.test.mjs
```
