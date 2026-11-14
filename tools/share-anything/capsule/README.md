# `public-scene-share/capsule/`

The pure, content-addressed `SceneCapsule` core: freeze a whole scene (tree + present chrome + every content-addressed subresource + the data it read) into an immutable, hashable unit, and prove it is publishable.

## Files

| File | Purpose |
|------|---------|
| `scene-capsule.ts` | Schema + invariants: `SceneCapsule`, `CapsuleRef`, `ResolvedRef`, `CapsuleArtifact`, `CapsuleData`, `CapsuleTier`, `CAPSULE_MANIFEST_VERSION`, `refKey`. |
| `closure-builder.ts` | `buildSceneCapsule` — the transitive, cycle-safe, deterministic walk that freezes the closure and validates it (the §6 "biggest risk" core). |
| `closure-validators.ts` | The two publish gates: `validateReferenceClosure` (no unresolved ref ⇒ no blank render) + `validateTierClosure` (PUBLIC capsule ⇒ only-public subresources, D2.1). |
| `capsule-bytes.ts` | Content-addressing: `canonicalCapsuleBytes` (deterministic sorted-key bytes — the hash substrate, SP4) + URL minting (`capsuleContentPath` `/c/<hash>`, `capsuleShortPath` `/s/<id>`, `capsuleUrl`). Does NOT hash (runtime SSOT `makeHashCodeHexFromBytes` at the do-work layer) or do I/O. |
| `scene-closure.ts` | The bridge (T2b): `collectSceneRefs` (blind walk of a scene tree → `CapsuleRef[]`, never switches on node kind) + `sceneRefResolver` + `sceneClosureInput` → a `ClosureBuildInput` for `buildSceneCapsule`. Pure; the live engine query for scene + component metadata is the do-work caller's job. |
| `prune-scene.ts` | The presentation `root` mechanism (share scoping): `pruneSceneToRoot(scene, id)` — BLIND subtree extraction by `id` alone (L090; returns the matched node AS the new scene root, fail-closed `null` on a miss so the mint refuses rather than silently sharing the whole scene) + `listShareableRoots(scene, {labelField?})` — the scene's top-level roots as `{id,label}` for a DATA-driven scope picker. Pure; no kind/taxonomy switch. |
| `prune-scene.test.ts` | Prune gauntlet: subtree-by-id (incl. deep + top-node-self), fail-closed on unknown id, blind-to-kind, and `listShareableRoots` DATA labelField (6 tests). |
| `read-capsule.ts` | The render-side INVERSE (T5 decode): `readCapsule` / `readCapsuleBytes` — capsule bytes → `CapsuleRenderInput` (`sceneTree`/`chrome` opaque, artifacts/data indexed by `refKey`). Blind (L090), scene-format-agnostic (L098), forward-compat fail-closed on unknown `manifestVersion`. Pure; no infra. |
| `closure.test.ts` | Closure gauntlet: completeness, tier closure, cycle-safety, determinism, data-vs-artifact routing (8 tests). |
| `capsule-bytes.test.ts` | Determinism gauntlet: value-equal capsules ⇒ byte-equal canonical form; array order preserved; URL minting (5 tests). |
| `read-capsule.test.ts` | Reader gauntlet incl. the FORMAT ROUND-TRIP (mint a real scene → bytes → read → every ref resolves + scene/chrome survive verbatim): blind-to-kind, opaque passthrough, frozenData, fail-closed on bad version/artifact (6 tests). |
| `scene-closure.live-proof.test.ts` | Faithful proof: the whole pure pipeline run against the REAL captured studio scene (`__fixtures__/live-studio-scene.json`) — collects the real roots, mints a complete valid capsule (2 tests). |

## Key Types / Functions

| Type / Fn | Signature / Shape | Role |
|-----------|-------------------|------|
| `SceneCapsule` | `{ manifestVersion, tier, sceneSnapshot, frozenChrome, artifacts[], frozenData[] }` | The immutable content-addressed unit. NO per-viewer state (D2.2: `accessLease` lives in the mutable `/s` envelope). |
| `CapsuleRef` | `{ kind: string; id: string }` | Self-describing ref. `kind` is OPEN DATA — the capsule logic never branches on it (L090). |
| `ResolvedRef` | `{ integrity_hash?, public_readable, dependencies?, is_data?, value? }` | What a `RefResolver` returns for one ref. |
| `RefResolver` | `(ref) => ResolvedRef \| null` | Caller-supplied (the scene owner knows its format); `null` ⇒ unresolved ⇒ fails closure. |
| `buildSceneCapsule` | `(ClosureBuildInput) => { capsule \| null, validation }` | Freeze + validate. `capsule` is `null` iff `validation.ok` is false. Pure + deterministic. |
| `validateTierClosure` | `(tier, artifacts, tierIsPublic?) => TierClosureIssue[]` | DATA-driven public-tier check; default predicate = `tier === 'public'` (L083). |
| `readCapsule` / `readCapsuleBytes` | `(value \| bytes, supportedVersions?) => { ok, input } \| { ok:false, reason }` | Render-side decode (T5): capsule → `CapsuleRenderInput`. Inverse of `buildSceneCapsule`. |
| `CapsuleRenderInput` | `{ tier, sceneTree, chrome, artifactHashByRef, dataByRef }` | What the render shell needs to rebuild the scene offline; refs resolved by `refKey`. |
| `pruneSceneToRoot` | `(sceneTree, rootNodeId) => unknown \| null` | Scope a scene to one sub-root (the presentation `root`); blind by id, fail-closed `null` on a miss. |
| `listShareableRoots` | `(sceneTree, {labelField?}) => { id, label }[]` | Top-level shareable roots for a DATA-driven scope picker (label from a prop field, else the id). |

## Design invariants

- **Generic (enum-dissolution / L100):** ONE `artifacts[]` list, not separate component/dependency/asset buckets — to the capsule every subresource is `{hash, public_readable, kind}`.
- **Blind to scene format (L098):** never parses `sceneSnapshot` / `frozenChrome`; the scene owner extracts `rootRefs`.
- **Deterministic:** artifacts + data sorted by `refKey` ⇒ same scene ⇒ same bytes ⇒ same content hash. No clock, no randomness, no I/O.
- **No silent fallback:** an unresolved ref FAILS publish; the builder never invents a value or reads live app state.

## Dependencies

**Depends on:** nothing (zero-dependency pure leaf — L106 independent-inventor test).
**Depended on by:** `../do-work/` (the publisher — mint side, proven live) and `read-capsule.ts` (the T5 render-side decode). The public capsule render shell + its cross-origin sandbox host (T5) and the public HTTPS CAS origin (T3) are the remaining infra-gated consumers.
