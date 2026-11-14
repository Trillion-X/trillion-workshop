# three-dimensional-scene

Descriptor-driven, browser-local Three.js projection for landing pages, teaching, simulations, and live operational surfaces.

The package owns descriptor validation, driver-to-track reduction, interaction output, semantic fallback, and GPU lifecycle. Callers own domain copy, assets, bindings, workflows, access, commerce, and package-set composition. New inputs and rendering behaviors are registered as capabilities; domain switches do not belong in this package.

For authored worlds, `batchImmutableStaticGeometry` collapses repeated opaque static siblings into owner-local `InstancedMesh` batches. Named room/track/interaction owners remain intact, transparent surfaces stay independently sortable by default, and runtime disposal releases instance buffers with the rest of the GPU lifecycle.

An asset may declare `qualityVariants.medium.input` (and optional high/low/fallback siblings). The runtime selects that source before loader/cache identity, so one descriptor can point mobile or reduced-motion surfaces at a bounded derivative while desktop retains the authored source. Variants are DATA; the generic runtime contains no product or room switch.

Reduced motion disables continuous mixer updates but still evaluates each autoplay
animation once at its descriptor-owned `startOffset`. Rigged assets therefore hold
an intentional static pose instead of falling back to an unevaluated bind/T-pose.

Every scene must remain complete without WebGL. The semantic story is the accessible and indexable authority; the canvas is enhancement. Interactions emit the shared `bitfield:surface-output` envelope and never invoke workflows directly.

Track keyframes may provide `responsive.mobile` and `responsive.tablet` values.
The runtime interpolates the selected viewport profile across the same ordered
timeline, falling back to the base `value` when no override exists. This keeps
portrait composition in descriptor DATA without domain-specific renderer code.
