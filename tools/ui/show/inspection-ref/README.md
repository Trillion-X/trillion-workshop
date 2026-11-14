# inspection-ref

Addressed inspection references: any rendered element can carry a self-describing ref that resolves — through a blind family→resolver registry — to the DATA records, fields, and owner-declared write paths behind it.

## Files

| File | Purpose |
|------|---------|
| `inspection-ref.ts` | The ref attribute, resolver registry factory, resolution walk, write-input substitution. |
| `inspection-ref.test.ts` | Unit + adversarial tests (portals, unknown families, many-to-one, malformed refs, self-reference). |
| `index.ts` | Barrel export. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `INSPECTION_REF_ATTR` | `'data-inspection-ref'` | DOM attribute carrying the serialized ref (transport only — authority is DATA). |
| `InspectionRef` | `NodeRef` (`{family, parts}`) | The ref. `family` is an open Society string published by the stamper. |
| `InspectionSource` | `{recordAddress, fieldPath?, descriptorRef?, write?, label?}` | One data source behind a target. `write` absent = read-only provenance. |
| `InspectionWriteDescriptor` | `{kind, definitionId?, inputTemplate?, expectedCurrent?}` | Owner-declared write path. `kind` is an open key dispatched by the host via registry. |
| `InspectionResolver` | `(ref, element) => InspectionSource[] \| null` | Per-family mapping registered by whoever owns the family. |
| `createInspectionResolverRegistry()` | `() => BlindRegistry<InspectionResolver>` | Fallbackless registry — unknown families are skipped, never errors. |
| `stampInspectionRef(ref)` | `(InspectionRef) => Record<string,string>` | Attribute map to spread onto a render target. |
| `resolveInspection(target, registry)` | `(Element, registry) => InspectionSource[]` | Nearest-first walk up the target's `closest()` chain, concatenating all resolved sources. |
| `substituteWriteInput(template, ctx)` | `(template, {value, record, parts}) => object` | Pure `$value`/`$record`/`$parts.<key>` placeholder substitution for dispatch payloads. |

## Dependencies

**Depends on:** `ui/show/node-actions/node-ref` (serialize/parse), `ui/show/blind-registry`.
**Depended on by:** `ui/show/inspector-sidebar`; any surface/package wiring that registers a resolver family.

## Invariants

- The DOM attribute is transport; what is editable, with which editor, written where, is read from DATA at resolve time.
- No closed sets: family, write kind, and field shape are all open strings dispatched by lookup.
- Honest degradation: no stamp → `[]`; no resolver → skipped; no `write` → read-only provenance (never a fake editor).
- Resolution walks the element's own ancestry, so portaled elements resolve their own stamp.
