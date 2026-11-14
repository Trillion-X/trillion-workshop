# Catalog Processes

This folder stores package-owned process source for deriving catalog proposal data.

## Files

| File | Purpose |
|---|---|
| `README.md` | Process folder index. |
| `derive-catalog-snapshot.mjs` | Builds `data/catalog.json` from package-use proof, package contracts, offer refs, and package-owned language descriptors. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|---|---|---|
| `derive-catalog-snapshot.mjs` | `node derive-catalog-snapshot.mjs --package-set-root <root> --proof <file> --offer-exchange <file> --package-finding-language <file> --output <file>` | CLI entry for catalog snapshot derivation. |
| `findingBlocks` | `(values, tones) => CatalogFindingBlock[]` | Builds open visible block data from descriptor records. |
| `packageFindingScore` | `({ access, categories, capabilities, previewArt, source, execution }) => number` | Applies package-owned ranking weights while preserving owner refs. |

## Dependencies

**Depends on:** package-use proof JSON, package contracts, offer-exchange ref
JSON, package-finding language descriptors, optional preview stored bytes.

**Depended on by:** `data/catalog.json` generation and
`__tests__/catalog-deriver.test.mjs`.
