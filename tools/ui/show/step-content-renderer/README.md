# ui/show/step-content-renderer — blind walkthrough content registry

The L069 anti-enum heart of the `guided-overlay` walkthrough engine: a step's content (`{content_kind, payload}`) is rendered by a registry **lookup**, never a `switch(content_kind)`. A new content kind = one `register()` call + zero engine change.

## Files

| File | Purpose |
|------|---------|
| `step-content-renderer.ts` | Pure registry — `createStepContentRegistry(fallback)`, `register`/`resolve`/`has`/`kinds`, `registerStepContentRenderers`. Generic over renderer type `R` (framework-agnostic). |
| `StepContent.tsx` | React mount seam — specializes `R` to a component and mounts the resolved renderer for a content descriptor, blindly. |
| `index.ts` | Barrel. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `StepContentDescriptor` | `{ content_kind: string, payload: Record<string,unknown> }` | A step's content as DATA; `content_kind` is a raw open key (L090), `payload` renderer-owned. |
| `StepContentRegistry<R>` | `register / resolve / has / kinds` | Blind registry; `resolve(kind)` is a pure map lookup → renderer or fallback. |
| `createStepContentRegistry<R>(fallback)` | `→ StepContentRegistry<R>` | Build a registry; unknown kind → `fallback` (L083, never throws). |
| `registerStepContentRenderers(reg, map)` | bulk register | Bind a DATA-shaped `{kind: renderer}` map. |
| `StepContentComponent` | `ComponentType<{payload}>` | A React content renderer (text/media/quiz/outcome/…). |
| `StepContent({registry, content})` | React component | Mounts the resolved renderer — never branches on kind. |

## Why This Design (L069 / L090 / L083)

`content_kind` is an **open string**, not a TS union. Dispatch is a `Map.get`, so there is no closed enum, no `if (kind === 'quiz')`, no `switch`. Adding `media`, `quiz`, `outcome`, or a kind invented in 2099 is a `register(kind, renderer)` call — the registry source never changes. Unknown kinds render the fallback (safe default), so a DATA author can't crash the tour by naming an unregistered kind. This is the executable form of the plan's convergence gate (F1/F2/F6).

## Dependencies

**Depends on:** `react` (mount seam only; the registry itself has zero deps).
**Depended on by (planned):** the `guided-overlay` engine (mechanism M5) and its consumers' default renderer sets (text→Coachmark body, media→`MediaPlaybackSurface`, quiz→forms inputs, outcome→Coachmark body).
