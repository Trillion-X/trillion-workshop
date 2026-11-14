# funnel-offer-graph/do-work

Authoring seams that turn a user gesture into an additive `funnel-definition` DATA write.

## Files

| File | Purpose |
|------|---------|
| `create-funnel.ts` | Pure builders: create an honestly-empty funnel-definition, append title-only stages, and emit the additive `write-batch` request for its published-record address. |
| `create-funnel.test.ts` | Unit tests for the builders + a read-back/resolve round-trip. |
| `README.md` | This file. |

## Key Functions

| Function | Signature / Shape | Role |
|----------|-------------------|------|
| `slugify` | `(text: string) => string` | Generic text → url-safe identity fragment. |
| `funnelSlug` | `(funnelId: string) => string` | Identity tail of a `funnel:<slug>` id. |
| `funnelDefinitionAddress` | `(funnelId: string) => string` | Name-stable published-record address for a funnel. |
| `buildNewFunnelDefinition` | `(title: string, idEntropy: string) => FunnelDefinition` | Author a new, empty funnel (no fake stages — L117). Entropy is injected to stay pure. |
| `appendStage` | `(def: FunnelDefinition, stageTitle: string) => FunnelDefinition` | Return a new def with ONE title-only stage appended (deterministic, collision-free `stage_address`). |
| `buildFunnelDefinitionWrite` | `(def: FunnelDefinition) => FunnelDefinitionWriteRequest` | Additive `write-batch` of the whole record to `current-item/published-record` (the path the `funnel::funnel-definition-list` feed reads). |

## Dependencies

**Depends on:** `../read-data/funnel-definition` (the `FunnelDefinition` / `FunnelStageSpec` types — the stage_address DATA contract).

**Depended on by:** `../show/mount-funnel-canvas.tsx` (the "Create funnel" / "Add step" affordances dispatch these writes via `sendRequestToBitfieldTarget`).

## Why This Design

A funnel's behavior is DATA, not source (Physics vs Society). Creating or growing a funnel is authoring a `funnel-definition` record — never new engine code. Each builder is pure and total so the write it produces is unit-testable without a live engine; the mount injects the only impurity (entropy for unique ids). Writes are scoped additive upserts to one name-stable address (L121/L128) — never a whole-segment rebuild.
