# Bitfield Package Store Catalog

Catalog owns package listing source data and projects it into open record/action
records for package-store surfaces.

## Files

| File | Purpose |
|---|---|
| `README.md` | Package contract and proof index. |
| `things-to-store-and-run.json` | Package boundary records and stored-byte declarations. |
| `data/README.md` | Data folder index. |
| `data/catalog.json` | Generated catalog snapshot proposal data. |
| `data/package-finding-language.json` | Package-owned labels, block definitions, ranking weights, categories, shelves, and public text rewrites. |
| `data/replacement-catalog.json` | Canonical data-owned replacement catalog whose package evidence resolves through the catalog. |
| `data/record-definitions.json` | Generic field/block/relationship/action projection descriptors. |
| `read-data/README.md` | Reader folder index. |
| `read-data/read-catalog.ts` | Validates catalog snapshots with open `package_finding.blocks[]`. |
| `read-data/read-record-projections.ts` | Emits `generic.record_action_projection.v1` from catalog rows and descriptor records while preserving catalog-owned discovery metadata. |
| `processes/README.md` | Deriver folder index. |
| `processes/derive-catalog-snapshot.mjs` | Builds the catalog snapshot from package-use proof, package contracts, offer refs, and package-owned language data. |
| `show-ios-jscore/README.md` | iOS JSCore adapter contract and proof command. |
| `show-ios-jscore/mount-catalog-jscore.js` | Native screen-command adapter over the same generic projection/action refs as browser/desktop. |
| `__tests__/README.md` | Test folder index. |
| `__tests__/catalog-deriver.test.mjs` | Hermetic deriver integration proof. |
| `__tests__/ios-jscore.test.mjs` | JSCore VM proof for native snapshot output, sealed owner-action intents, queued/resolved states, and adversarial descriptor data. |
| `__tests__/load-ts-module.mjs` | Test helper for loading TypeScript readers. |
| `__tests__/record-projections.test.mjs` | Reader/projection/boundary/adversarial proof. |
| `package-preview.pfat.gz` | Package-owned preview animation bytes. |
| `package-preview.pfcf.gz` | Package-owned preview companion bytes. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|---|---|---|
| `CatalogFindingBlock` | `{ id, render_kind, role, label?, value?, values?, tone_key?, owner_ref? }` | Open visible attribute contract; new labels/states are data. |
| `readBitfieldPackageCatalog` | `(value: unknown) => BitfieldPackageCatalog` | Validates catalog rows without fixed display label slots. |
| `readRecordActionProjection` | `(rawCatalog, rawDefinitions) => GenericRecordProjection` | Folds rows through generic descriptors into record/action projections. |
| `derive-catalog-snapshot.mjs` | CLI with `--package-set-root`, `--proof`, `--offer-exchange`, `--package-finding-language`, `--output` | Produces source proposal catalog data from owner refs and descriptors. |
| `BitfieldPackageStoreCatalogJscore.renderNativeSnapshot` | `(projection, lifecycleKey?) => NativeSnapshot` | JSCore-safe native command snapshot over `generic.record_action_projection.v1`. |
| `BitfieldPackageStoreCatalogJscore.ownerActionIntent` | `(action, record, mode?) => GenericOwnerActionIntent` | Preserves owner target refs and action input without local side effects. |

## Dependencies

**Depends on:** package-use proof data, package contracts, package-owned language
data, package-store offer-exchange refs, generic record/action projection
descriptors.

**Depended on by:** package-store browse/detail surfaces, browser/desktop/iOS
consumers that read `generic.record_action_projection.v1`, and owner-action
handoff flows that use opaque action target refs.

## Current Contract

- `data/catalog.json` is source proposal data for catalog rows.
- `data/package-finding-language.json` owns visible block recipes and rank
  weights as data.
- `data/replacement-catalog.json` owns founder-facing supported jobs, package
  evidence, comparison rows, integration requirements, economics, gaps, and
  request recovery; the catalog deriver carries it into discovery.
- `data/record-definitions.json` describes open field, block, relationship, and
  action roles. Labels and states are data, not code branches.
- `read-data/read-catalog.ts` validates the current catalog snapshot shape with
  `package_finding.blocks[]`.
- `read-data/read-record-projections.ts` projects catalog rows into
  `generic.record_action_projection.v1` and preserves catalog-owned discovery
  metadata beside the row projection.
- `show-ios-jscore/mount-catalog-jscore.js` reads the same serialized
  projection through `record-action-projection` input or mount props and emits
  native screen operations only.
- `things-to-store-and-run.json` publishes both readers and the record
  definitions, plus the JSCore native screen-command entry, as package-owned
  stored bytes/records.

## External Reader Links

Catalog links to package-store-reviews through
`package::bitfield-package-store-catalog::external-reader::package-store-reviews`.
That record names the finished reader output
`package::package-store-reviews::reader-output::browse-summary`. Catalog remains
the owner of package listing metadata and does not store user review text,
report state, reply rows, or review aggregates as catalog truth.

## Proof

`bitfield-package-store.resolve-current-install-inputs` takes the catalog it is handed (the caller reads this package's current
catalog from its own store; the resolver reads and sends nothing) and prepares the existing `package-files.install-packages-from-pointers`
request for an exact `package_identity` and optional selected `package_set`. It performs no
installation and grants no access or publisher trust. Caller-supplied catalog,
pointer and trust values are ignored. Missing package identity, malformed explicit destination, missing or ambiguous
rows, revoked packages, absent signed pointers or trust references return
`unavailable` with exact `missing_fields`, never a callable substitute. A runtime
partition is not a package-set selection. An omitted destination remains omitted:
the existing native `request_package_set_or_active_app_package_set` owner must
resolve exactly one package set from its configured app, refusing zero or multiple
sets. Neither the source package set nor caller runtime context supplies a default.
This is the direct native target contract, not the stricter workflow action schema.
The installer still owns signature,
access, compatibility and mutation checks; prepared input is not permission.

```bash
node --test packages/bitfield-package-store-catalog/__tests__/record-projections.test.mjs packages/bitfield-package-store-catalog/__tests__/catalog-deriver.test.mjs
node --test packages/bitfield-package-store-catalog/__tests__/ios-jscore.test.mjs
npx vitest run --config ./vitest.config.ts packages/package-store-reviews/tests/consumer-boundary.test.ts
```
