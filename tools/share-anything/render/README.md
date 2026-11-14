# `public-scene-share/render/`

The render-side: turn a decoded capsule into something the EXISTING generic scene painter renders, with NO live engine and NO painter change.

## Why a separate folder from `capsule/`

`capsule/` is BLIND to scene format (L098) — it freezes, validates, decodes, and content-addresses the closure, but NEVER parses `sceneSnapshot`. This folder DOES parse the scene tree (it knows the scene-node format `component_id` / `things_to_put_on_screen` and the painter format `artifact.hash` / `source_bytes`). That scene+painter-format knowledge is the render side's concern — mirroring how `do-work/` owns the live-scene format on the mint side. Keeping it here preserves the `capsule/` core's scene-format-agnostic invariant.

## Files

| File | Purpose |
|------|---------|
| `to-renderable-scene.ts` | `capsuleToRenderableScene(input, config?)` — rewrite a decoded capsule's scene so each component mounts from its FROZEN content hash (static CAS artifact) instead of its live address. The painter then takes its existing STATIC path. Pure, blind to node kind (L090), painter-contract as DATA (L098). |
| `to-renderable-scene.test.ts` | Gauntlet: freezes to static hash + drops live source, input not mutated, blind-to-kind, fail-closed on un-frozen component, honors alternate DATA config (5 tests). |
| `mount-capsule.ts` | `mountCapsuleFromHash(hash, deps, config?)` — the VIEWER orchestration core: fetch capsule bytes → `readCapsuleBytes` → `capsuleToRenderableScene` → hand to an injected painter. Pure over injected I/O + painter (`deps.fetchCapsuleBytes` / `deps.mountScene`), so it works for the cross-origin viewer (bundles its painter), the local owner-preview (imports the shell painter), and tests (inject a recorder) — and is decoupled from where the painter source lives. Fail-closed (structured reason, never a half-scene). Plus `capsuleHashFromUrl(url, queryKey?)` — read `?c=<hash>` or `/c/<hash>`. |
| `mount-capsule.test.ts` | Gauntlet on a REAL minted capsule: fetch→decode→rewrite→mount freezes the component to its static hash; fail-closed on empty hash / fetch throw / undecodable bytes / painter throw; URL hash parsing (9 tests). |

## Key Functions

| Fn | Signature / Shape | Role |
|----|-------------------|------|
| `capsuleToRenderableScene` | `(input: CapsuleRenderInput, config?: RenderableSceneConfig) => unknown` | Live-address → static-CAS-hash scene rewrite. Returns a NEW tree. |
| `RenderableSceneConfig` | `{ componentIdField, thingsField, artifactHashPath, liveSourceField }` | Painter-contract as DATA — mirrors the shell's `THINGS_TO_PUT_ON_SCREEN_CONTRACT`, never hardcodes shell internals. |
| `DEFAULT_RENDERABLE_SCENE_CONFIG` | `{ 'component_id', 'things_to_put_on_screen', ['artifact','hash'], 'source_bytes' }` | The maximally-capable default (L083) for the current live scene + painter format. |

## How it renders with ZERO painter change

The shell painter (`background-runner-shell/src/static/things-to-put-on-screen.js`) already resolves a "thing to put on screen" two ways: LIVE (`source_bytes` address → resolve via engine) or STATIC (`artifact.hash` → fetch `/cas/<hash>`). It picks STATIC when there is no live `source_bytes`. So freezing = drop `source_bytes` + set `artifact.hash`; the same generic painter mounts the component from CAS. Proven end-to-end against the REAL shell painter in `../proof/2026-06-26-live-mint-proof.mjs` (RENDER-THROUGH-PAINTER section).

The cross-origin sandbox (T5/D1) is SECURITY hardening for UNTRUSTED capsule bytes — orthogonal to this render mechanism, and remains infra-gated.

## Dependencies

**Depends on:** `../capsule/` (`CapsuleRenderInput` type + `refKey` — the decoded-capsule contract).
**Depended on by:** the T5 public capsule render shell (supplies its painter-matching `RenderableSceneConfig`, then hands the rewritten tree to the existing generic painter). Also exercised by `../proof/2026-06-26-live-mint-proof.mjs`.
