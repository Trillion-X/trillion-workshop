# proof/emergent-domains/

Pure DATA plus a live-author script proving that many unrelated business domains render from the
generic `visual-database` primitive with zero new code per domain.

## Files

| File | Purpose |
|------|---------|
| `emergent-configs.mjs` | The domain DATA and the pure builders over it. No I/O, so the offline test and the live-author script share one source. Exports `EMERGENT_CONFIGS`, `buildEmergentBoard`, `domainWrites`. |
| `author-emergent-configs.mjs` | Writes the domain set into a running app through the runtime kit's current-state write path. Takes `--dry-run`. Partition `bitfield-studio`. |

## Key Functions

| Export | Signature / Shape | Role |
|--------|-------------------|------|
| `EMERGENT_CONFIGS` | `[slug, label, stages[], extras[]][]` | One row per domain. Adding a domain is one row here and nothing else. |
| `buildEmergentBoard` | `(slug, label, stages, extras) => { typeId, fields, views }` | Builds the generic `visual-database.fields` and `visual-database.views` descriptor DATA for one domain. |
| `domainWrites` | `(slug, label, stages, extras) => AddressedWrite[]` | The entity-type rows plus ONE generic `kind:"board"` carrier at `package::visual-database::board::<slug>`. |

## Dependencies

**Depends on:** nothing at module scope in `emergent-configs.mjs`, which is what lets the offline
test import it with no engine. `author-emergent-configs.mjs` depends on the runtime kit's
`target-basis` and `apply-current-state-writes-live` scripts.

**Depended on by:** `../emergent-domains-contract.test.ts`, which decodes every config through
`visual-database`'s own blind decoder and projector.

## Why This Design

The claim under test is that the primitive is universal, so the proof has to be DATA rather than
code. If a new domain needed a code change, the claim would be false, and the shape of this folder is
what makes that visible: a domain is one row in one array.

The offline test and the live-author script import the SAME builders. If they had separate copies,
the test could pass against DATA the author never writes.

## History

This proof lived under `packages/crm/` until 2026-09-05, when that package was deleted as superseded.
It never belonged there: it imports only `visual-database`'s decoder and its own DATA, and the claim
it proves is `visual-database`'s. Nothing referred to it from outside, which is what being in the
wrong folder means, so no referrer sweep could surface it and deleting the folder would have taken
the successor's own genericity proof.

The date was dropped from the folder name during the move. A proof is named for what it proves, never
for when it was first written.

## Known Stale Value

`emergent-configs.mjs` still writes `type:crm-entity-type` as the `entity_types` row's `type_id`. It
names a deleted package and is deliberately NOT renamed here: that value is part of the address the
author script writes, so changing it in source would author a second parallel type on the next run
rather than move the first. Renaming it is a live-data migration that has to retract the old rows,
tracked at
`notes/projects/packages-and-package-sets/_shared/plans/2026-09-05-package-source-reaches-past-the-engine/`.
