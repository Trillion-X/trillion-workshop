# Output Destination Primitive

Generic, data-driven output delivery seam for produced text/bytes (exports, downloads, clipboard, etc.).

## Purpose

ONE physics-only primitive where destinations are registered via injected capability maps and calling packages supply DATA rows. New destination = one DATA row in the caller's package; zero seam changes (L069/L090 generative primitive + envelope-addressed capability injection).

## Files

| File | Purpose |
|------|---------|
| `types.ts` | Core types: `OutputPayload`, `OutputDeliverCapability`, `OutputDestination` |
| `read.ts` | Catalog merging: `mergeOutputDestinations()`, `findOutputDestination()` |
| `index.ts` | Barrel export |
| `output-destination.test.ts` | Unit tests: merge semantics, injected capability dispatch, fail-closed |

## Key Types

| Type | Signature | Role |
|------|-----------|------|
| `OutputPayload` | `{ filename, mimeType, text?, bytes? }` | Payload ready to deliver |
| `OutputDeliverCapability` | `(payload) => Promise<boolean>` | Injected delivery implementation (never enumerated by seam) |
| `OutputDestination` | `{ id, label, hint?, deliver }` | Registered destination with injected capability |

## Dependencies

**Depends on:** none (pure leaf, no I/O)

**Depended on by:** any package that needs envelope-addressed output delivery (group/show for board export, etc.)

## Physics vs Society

**Physics (this file):** The seam that dispatches through an injected capability map. Zero knowledge of destination KINDS.

**Society (caller's package):** Destination DATA rows that register specific implementations (`clipboard`, `download`, `selectable-text`, etc.). New kind = one row + one injected function; seam untouched.

## Pattern: Catalog Merging

`mergeOutputDestinations()` mirrors existing `mergeCatalog` patterns throughout the codebase:
- Accepts multiple catalogs
- Deduplicates by ID
- Returns merged array
- Later entries win in case of conflict

This enables packages to compose built-in + user-provided destinations.

## L090: The Handler Never Enumerates

The seam (`packages/group/show` board export panel) never has a switch statement over destination kinds:

```typescript
// WRONG (enum dissolution violation):
if (dest.id === 'clipboard') { ... }
else if (dest.id === 'download') { ... }

// RIGHT (L090 — seam is blind):
await dest.deliver(payload);  // The injected function carries all knowledge
```

Destinations are self-contained; the seam simply dispatches through them.
