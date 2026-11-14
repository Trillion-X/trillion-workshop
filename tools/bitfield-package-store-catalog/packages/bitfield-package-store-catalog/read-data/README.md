# Catalog Readers

Readers in this folder are pure TypeScript source for catalog data.

## Files

| File | Purpose |
|---|---|
| `README.md` | Reader folder index. |
| `read-catalog.ts` | Validates the catalog snapshot with open `package_finding.blocks[]`, opaque owner refs, and catalog-owned discovery metadata. |
| `read-record-projections.ts` | Emits `generic.record_action_projection.v1` from `catalog.json` plus `record-definitions.json`, preserving catalog-owned discovery metadata. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|---|---|---|
| `CatalogFindingBlock` | `{ id, render_kind, role, label?, value?, values?, tone_key?, owner_ref? }` | Open visible finding attribute. |
| `readBitfieldPackageCatalog` | `(value: unknown) => BitfieldPackageCatalog` | Validates catalog rows without fixed display label fields. |
| `GenericProjectionBlock` | `{ id, render_kind, role, label?, value?, values?, tone_key?, source_path? }` | Projection block emitted for surfaces. |
| `readRecordActionProjection` | `(rawCatalog, rawDefinitions) => GenericRecordProjection` | Descriptor-driven projection reader. |

## Dependencies

**Depends on:** `data/catalog.json` shape and `data/record-definitions.json`
projection roles.

**Depended on by:** package-store browse/detail renderers, tests, and package
boundary stored-byte declarations.

The projection reader preserves unknown fields, labels, and domain values as
data. It does not create package-specific status enums.
