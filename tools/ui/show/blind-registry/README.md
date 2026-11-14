# ui/show/blind-registry — the shared data-key→handler dispatch primitive

The one generative primitive (L069) behind every "self-describing DATA key → handler" dispatch: an open string key maps to a handler by **lookup**, never `switch`/`if (key === ...)`. Adding a key is one `register()` + zero change to any dispatcher.

## Files

| File | Purpose |
|------|---------|
| `blind-registry.ts` | `createBlindRegistry<R>({fallback?})`, `registerAll`. Generic over handler type `R`. |
| `blind-registry.test.ts` | Lookup/new-key/fallback/throw-without-fallback/replace/empty-key tests. |
| `index.ts` | Barrel. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `BlindRegistry<R>` | `register / get / resolve / has / keys` | `get` = raw lookup (`R｜undefined`); `resolve` = lookup-or-fallback (throws only if no fallback configured). |
| `createBlindRegistry<R>({fallback?})` | `→ BlindRegistry<R>` | Pass `fallback` to make `resolve` total (L083); omit when callers use `get` and handle `undefined`. |
| `registerAll(registry, map)` | bulk register | Bind a DATA-shaped `{key: handler}` map. |

## Consumers (configurations of this one primitive)

- `step-content-renderer` — `content_kind` → renderer (with fallback).
- `anchor-resolver` — `target_ref.from` → ref resolver (no fallback; uses `get`).
- (planned) `step-progress` — `progress_style.style` → progress renderer.
- Any future data-driven dispatch should reuse this instead of hand-rolling a `Map`.

## Why This Design (L069 / L100)

Three near-identical `Map<string,handler>` dispatchers (content, anchor, progress) collapse to this one primitive — genericization shrinks code (L100) and the same anti-enum guarantee (no `switch(kind)`) is enforced in one place. Framework-agnostic: `R` may be a React component, a resolver function, or anything.

## Dependencies

**Depends on:** nothing (zero-dep leaf).
**Depended on by:** `step-content-renderer`, `anchor-resolver`, and future data-driven dispatchers.
