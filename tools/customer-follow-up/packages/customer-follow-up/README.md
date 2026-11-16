# Customer Follow-Up

Customer Follow-Up is a generic package for product/customer lifecycle tracking:
targets, contacts, steps, evidence refs, owner refs, and follow-up action
requests.

## Boundary

This package owns:

- `customer-product-target`
- `customer-contact`
- `customer-step`

This package does not own CRM relationship truth, contact identity truth, email
delivery, calendar bookings, checkout/payment truth, access entitlements,
content publishing, analytics collection, or fake customer data. It stores
customer lifecycle evidence that points to those owners.

## Files

| File | Purpose |
|---|---|
| `things-to-store-and-run.json` | Package capability, placeable surface, factflow, contracts, entry, and workflow action records |
| `entry-to-package-data-map.json` | Entry point mapping for Runtime Kit package import |
| `read-data/` | Generic customer follow-up projections |
| `do-work/` | Workflow action input construction |
| `show/` | React surface and mount entry |
| `proof/` | Mobbin reference and visual acceptance evidence |
| `__tests__/` | Focused package tests |

## Latest Proof

The focused proof command is:

```bash
npx vitest run --config ./vitest.config.ts packages/customer-follow-up/__tests__/customer-follow-up.test.ts
```

Latest source result:

- 2 test files passed.
- 10 tests passed.

The backend proof file is `proof/backend-proof.md`. It records the content
production, content distribution, and customer follow-up loop proof without
creating fake contacts, purchases, access grants, customer rows, screenshots,
or product usage data.

Live app-open proof remains pending until this source is admitted through the
package implementation proposal/import path into the selected app log.

## Runtime Input Contract

The package surface reads `published-records`; `things-to-store-and-run.json`
must keep the matching `bitfield-input-descriptor` so app-open material scopes
can resolve the records without relying on screen-arrangement internals.
