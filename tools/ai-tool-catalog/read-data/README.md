# parts/ai-tool-catalog/read-data/

The one decoder of the Workshop's shared DATA: turns published tool, placement, licence, price, byte store, gateway, search source, row source and event source rows into typed items, refusing any row that cannot work (with its reason) instead of guessing.

## Files

| File | Purpose |
|------|---------|
| `read-ai-tool-catalog.ts` | `readToolData(records)` admits each published record by its `kind` through one admit function per kind and returns every kind's items plus the refused rows; `readToolCatalog(records)` returns only the tools. |
| `declared-effects.ts` | What a tool's run changes on the screens that show it, declared once on its row (`effects`: `{ on: mutate \| success, action: update \| invalidate, read: [literal \| { from, path }], merge? }`). `declaredEffectsProblem` is the decoder's check, `effectsAt(effects, phase, { input, output })` resolves one call's effects (an effect missing a value is left out), `effectReads` lists their reads and `applyMerge` lays one merge (set, append, replace, remove) on an answer without changing it. src/workshop.mjs answers a completed run's `changes` from it; the workspace's runner reads those screens again (src/workspace/needs-you.tsx runAll, store-changes.ts readTheseAgain). |

## Key types and functions

| Name | Shape | Role |
|------|-------|------|
| `readToolData(records, knownPlacements?)` | `→ ToolData { tools, placements, licence_classes, notices, prices, byte_stores, gateways, search_sources, row_sources, event_sources, refused }` | The one read of the shared rows (src/workshop.mjs `readToolData`). |
| `readToolCatalog(records)` | `→ ToolCatalogItem[]` | Tools only. A tool's optional `listed_on` (when it was added to Trillion, a date) is kept; the sidebar's New list reads it (src/work-workshop.mjs toolSurfaces). |
| `admitToolDescriptor(payload)` | `→ { item } \| { refused }` | One tool descriptor checked. |
| `ToolEventSource` | `{ id, label, signature? \| poll?, events[], route_key, event_id, route_key_proof, connects_with?, delivery_policy?, default_rule? }` | An event source (src/events.mjs); `default_rule { skip?, batch? }` is how its default rules quiet themselves (src/starting-rules.mjs). |
| `ToolCatalogItem`, `ToolPlacement`, `ToolLicenceClass`, `ToolPrice`, `ToolByteStore`, `ToolGateway`, `ToolSearchSource`, `ToolRowSource`, `ToolOutcomeNotice`, `Refusal` | typed rows | What each other kind decodes to. A tool's optional `retry` ({ max_attempts, first_after_seconds, factor, longest_after_seconds }, each above 0) is kept, so a rule's failed run of it starts again by itself (src/automations.mjs); a malformed one refuses the row. |
| `secretValuePath(value)` | `→ string \| null` | Refuses a row holding a secret value rather than a secret name. |
| `validatedSelector`, `canonicalCapabilityRef`, `DEPLOYED_HOST`, `BLAKE3_FINGERPRINT`, `MINIMUM_HOST_VERSION` | helpers and constants | Shared checks the admit functions use. A tool's optional `minimum_host_version` (the oldest Trillion, server.json `version`, it runs on) must match `MINIMUM_HOST_VERSION`; src/tool-releases.mjs picks the newest release a Trillion runs by it. |

## Dependencies

**Depends on:** `parts/ui/read-data/declared-selector.ts` (output selectors).
**Depended on by:** `src/workshop.mjs` (readToolData), `src/events.mjs` and `src/starting-rules.mjs` through the admitted event sources, `scripts/workshop-rows.mjs` tests.
