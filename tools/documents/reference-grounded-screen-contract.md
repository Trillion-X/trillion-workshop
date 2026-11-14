# Composition Scene — Reference-Grounded Screen Contract

## Boundary

- Package root: `<checkout>/packages/documents`
- Active rendered entry: `show/mount-composition-scene.tsx`
- Shared engine handoff: `do-work/hydrate-composition-scene.ts`
- Product job: render any addressed authored composition as a live, permission-gated surface without authoring chrome.
- Dominant action: consume the authored scene and interact with its mounted owner surfaces.

## Reference contract

The locked community reference contract is
`<checkout>/notes/projects/tribes/plans/2026-07-22-community-artifact-sharing/reference-grounded-screen-contract.md`.
The rendered scene must preserve its authored hierarchy and density; a visual
community topology cannot collapse into a generic flat card list.

## Anatomy

- One measured fill stage with no fixed viewport height.
- Kernel-positioned authored nodes and kernel-routed visible edges.
- Component nodes mount their declared `package_entry` and invocation input.
- Society labels for loading, empty, and error states come from scene input.
- Optional bound data is read only when its input name is declared.
- Desktop and mobile use the same authored topology; responsive behavior comes
  from composition DATA and the measured viewport sent to the kernel.

## Human-language boundary

The surface may display authored labels and owner-supplied content. It must not
display package names, workflow IDs, address labels, receipt IDs, storage modes,
or backend status vocabulary as customer copy.

## Shared primitives

- `CompositionSurfaceContent` renders the kernel snapshot.
- `PlaceableSurfaceHost` mounts authored Component nodes.
- `FloatingMaterialFrame`, `ErrorBoundary`, and shared UI tokens provide frame,
  recovery, typography, and color behavior.
- Missing generic rendering behavior is added to these shared primitives, not
  duplicated in a community or course package.

## Render-state matrix

| State | Required observable result |
|---|---|
| Loading | Scene-authored loading label; no fabricated content |
| Empty | Scene-authored empty label; no feed-specific fallback |
| Sparse | Authored topology and spacing remain intact |
| Dense | Stage scrolls; mounted surfaces remain interactive |
| Error | Safe scene-authored error label; no backend text |
| Revoked | Content unmounts on the next access projection revision |
| Mobile | 390px viewport has no horizontal clipping or fixed-height collapse |
| Desktop | 1440px viewport uses authored layout and visible edge routes |

## Proof

- Source proof: `composition-scene.mount.test.tsx`, full Documents
  suite, item-record conformance, and PlaceableSurfaceHost cycle tests are green.
- Bundle proof: `entry-bytes-composition-scene` builds from the scoped entry.
- Live visual proof remains OPEN until T7/T8 captures the 390px and 1440px
  production states after basis-checked activation. Source tests are not visual
  acceptance.
