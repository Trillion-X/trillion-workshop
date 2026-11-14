# Catalog Data

This folder stores package-owned catalog source data and projection descriptors.

## Files

| File | Purpose |
|---|---|
| `README.md` | Data folder index. |
| `catalog.json` | Generated catalog row snapshot proposal data. |
| `package-finding-language.json` | Human labels, open finding block definitions, ranking weights, categories, shelves, and text rewrites. |
| `replacement-catalog.json` | Canonical founder-facing replacement catalog: package evidence, supported jobs, comparison rows, integration requirements, economics, gaps, and request recovery. |
| `record-definitions.json` | Generic record/action projection definition set. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|---|---|---|
| `package_finding.blocks[]` | `{ id, role, render_kind, label?, value?, values?, tone_key? }[]` | Open card/detail attributes; new display facts are data rows. |
| `finding_blocks[]` | `{ id, role, render_kind, label, value_source, tone_source? }[]` | Source-owned recipe for generating finding blocks. |
| `record-definition:catalog-row` | field, block, relationship, and action roles | Generic projection contract consumed by readers. |

## Dependencies

**Depends on:** package-use proof, package contracts, offer/access owner refs,
and package-owned language descriptors.

**Depended on by:** `read-data/read-catalog.ts`,
`read-data/read-record-projections.ts`, and
`processes/derive-catalog-snapshot.mjs`.

Active data does not reference the stale
`bitfield-package-store-install-surface` owner. Selected package-file work goes
through the current `bitfield-package-store-local-package-files` owner and the
generic package-files target.
