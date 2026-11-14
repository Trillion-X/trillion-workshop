# `public-scene-share/do-work/`

The publisher orchestration: read the live scene a user is sharing, freeze its components by content hash, mint a content-addressed capsule, and persist its bytes to CAS.

## Pipeline

```
readScene (live `scene` sink)
   │
   ▼
liveSceneComponentSources   → { refKey → {address, partition} }   (what the scene NAMES)
   │
   ▼
resolveComponentMeta        → { refKey → ResolvedRef(content hash) }  (freeze address → CONTENT hash)
   │
   ▼
mintCapsule                 → buildSceneCapsule → canonical bytes → hash → CAS write → {capsuleHash, /c/<hash>}
```

`publishSceneCapsule` (create-capsule.ts) is the entry point that wires these. All live I/O (`readScene`, `resolveComponentHash`, `storeBytes`, `hashBytes`) is injected at the boundary, so the orchestration is pure + unit-testable.

## Files

| File | Purpose |
|------|---------|
| `create-capsule.ts` | `publishSceneCapsule(deps, options)` — THE create-capsule orchestration: read → sources → resolve → mint. Pure over injected live I/O. |
| `create-capsule.test.ts` | full chain on the REAL captured studio scene (mint+store+/c path; deterministic; fail-closed) (3 tests). |
| `extract-live-scene-meta.ts` | `liveSceneComponentSources` — blind (L090) walk of the live scene → each component's byte SOURCE `{address, partition}`. Scene byte-source layout is DATA (`LiveSceneSourceConfig`), never hardcoded (L098: live-format knowledge stays here, not in `capsule/`). |
| `extract-live-scene-meta.test.ts` | source collection, blind-to-kind, absent-source, config genericity, dedup (5 tests). |
| `resolve-component-meta.ts` | `resolveComponentMeta(sources, resolveHash, opts)` — freeze each component's mutable address → its immutable CONTENT hash via injected live I/O (so capsule artifacts are CAS-fetchable). |
| `resolve-component-meta.test.ts` | address→hash freeze, tier policy, unresolvable-address-stays-empty (3 tests). |
| `mint-capsule.ts` | `mintCapsule` — scene + resolved metadata → `buildSceneCapsule` → canonical bytes → hash → CAS write → `{capsuleHash, contentPath}`. Fail-closed (incomplete/tier-invalid closure ⇒ structured failure, writes nothing). |
| `mint-capsule.test.ts` | mint succeeds + stores; fails-closed on incomplete closure and on tier violation, writing nothing (3 tests). |

## Key Functions

| Fn | Signature / Shape | Role |
|----|-------------------|------|
| `publishSceneCapsule` | `(ScenePublisherDeps, PublishSceneOptions) => Promise<MintCapsuleResult>` | The create-capsule entry point. |
| `ScenePublisherDeps` | `{ readScene, resolveComponentHash, storeBytes, hashBytes }` | All live I/O, injected at the boundary. |
| `liveSceneComponentSources` | `(sceneTree, config?) => Record<refKey, ComponentSource>` | Pure scene reader; blind to node kind. |
| `resolveComponentMeta` | `(sources, resolveHash, opts?) => Promise<Record<refKey, ResolvedRef>>` | Address → content hash freeze. |
| `mintCapsule` | `(MintCapsuleArgs) => Promise<MintCapsuleResult>` | Pure orchestration over injected `hashBytes`/`storeBytes`/`meta`. |
| `MintCapsuleArgs` | `{ sceneTree, frozenChrome, tier, meta, hashBytes, storeBytes, fields?, tierIsPublic? }` | Live wiring is injected at the boundary, never imported into the logic. |

## Why deps are injected

`storeBytes` is the **local** CAS write today (`engine.operation.write-batch`) and becomes a **public HTTPS CAS** write once T3 stands one up — the capsule bytes are IDENTICAL; only the serving origin changes. So this module never blocks on the origin decision. `hashBytes` is the runtime SSOT `makeHashCodeHexFromBytes`. `resolveComponentHash` reads a component address's current bytes and hashes them (the live address→content-hash freeze) — also a boundary adapter. A scene references components by **mutable address**; a capsule must carry the **immutable content hash**, which is why the resolve step exists.

## Dependencies

**Depends on:** `../capsule/` (scene-closure, closure-builder, capsule-bytes, scene-capsule — the pure core).
**Depended on by:** the `public-scene-share.create-capsule` target wiring (things.json handler / share action — supplies the real `readScene`/`resolveComponentHash`/`storeBytes`/`hashBytes`). Proven live end-to-end in `../proof/2026-06-26-live-mint-proof.mjs`.
