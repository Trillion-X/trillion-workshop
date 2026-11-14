# region-drop-intent/

Generic, blind drop-intent router for a region: while a subject is dragged over a region, route the drop to one of the owner-provided intents (default = whole-region zero-aim; others render as cards), with nest coordination so only the innermost region paints its overlay.

## Files

| File | Purpose |
|------|---------|
| `region-drop-intent-types.ts` | The intent capability contract (`DropIntentCapability {accepts, apply}`), `DropIntentPack`, `RegionDrop`, and the blind selectors `acceptedIntents` / `defaultIntent`. No closed union (Pattern 81). |
| `RegionDropRouter.tsx` | The router component: wraps a region's content, activates on drag-enter, paints the default catcher + non-default intent cards, routes the drop (fallback to default so a drop is never lost). Nest-aware (see `region-drop-nest.ts`). It renders ONE wrapper element whether idle or active, so activating never remounts the regions nested inside it (a remount mid-drag erased the containers' split zones), and it claims its nest depth in a layout effect so an outer overlay never paints over an active inner region. |
| `region-drop-nest.ts` | Nest coordination: `RegionDropNestStore` (pure, refcounted depth tracker) + `RegionDropNestContext`. When routers NEST, only the deepest active one paints its overlay (no double cards). |
| `region-drop-nest.test.tsx` | Proves the store (depth/refcount/subscribe) + the router (nested → one overlay; single → unchanged). |
| `index.ts` | Barrel: exports the router, the types/selectors, and the nest store/context. |

## Key Types / Functions

| Type / Fn | Signature / Shape | Role |
|-----------|-------------------|------|
| `DropIntentCapability` | `{ id, label, icon?, priority?, isDefault?, accepts(drop)→bool, apply(drop)→bool|void|Promise }` | One owner-provided drop route. Router reads only metadata + calls accepts/apply. |
| `DropIntentPack` | `readonly DropIntentCapability[]` | Owner-provided intent set; ordered by `priority`, not array index. |
| `RegionDrop` | `{ region: AddressRef, dataTransfer, clientX, clientY }` | Handed to accepts (types-only at hover) and apply (full transfer at drop). |
| `acceptedIntents(pack, drop)` | `→ DropIntentCapability[]` | Intents whose `accepts` is true, sorted by priority (blind). |
| `defaultIntent(intents)` | `→ DropIntentCapability \| null` | The whole-region fallback among a set. |
| `RegionDropRouter` | `({ region, intents, children, className }) → ReactElement` | The router. Innermost-only overlay via the nest store. |
| `RegionDropNestStore` | `{ claim(depth), release(depth), maxActiveDepth()→number, subscribe(cb)→off }` | Pure shared depth tracker; `-1` when none active. |
| `createRegionDropNestStore()` | `→ RegionDropNestStore` | Factory (the outermost router owns one; nested routers share it via context). |
| `RegionDropNestContext` | `React.Context<{ store, depth } \| null>` | Threads the shared store + this router's depth to nested routers (`null` = outermost). |

## Dependencies

**Depends on:** `@/packages/ui/show/icon` (`NamedIcon` for intent cards), `@/packages/ui/show/visual-layer-stack/visual-layer-types` (`AddressRef`), `react`.

**Depended on by:** `screen-arrangement` — `ContainerHost.tsx` (pane router), `FreeformArranger.tsx` (canvas router), and `region-drop-intents.ts` (the owner-provided intent packs). Exported via `@/packages/ui` barrel.

## Why nest-awareness (Invariants)

- A router paints its overlay only when it is the deepest currently-active region (`depth >= maxActiveDepth`). Outermost router = depth 0; each nested router = parent depth + 1; all nested routers share the outermost's store.
- Zero-regression for the non-nested case: a lone router is depth 0 = innermost = paints exactly as before.
- Without this, a freeform canvas router wrapping container routers (or a future surface-root router wrapping panes) would paint double zone cards (such as "Present") over the inner region.
- Acceptance is asked again on every `dragover` (`onDragOverCapture`), so an intent that accepts only part of the region (the stage-only "Set as background") lights up where it applies and steps aside, overlay and all, as soon as the pointer moves off it.
