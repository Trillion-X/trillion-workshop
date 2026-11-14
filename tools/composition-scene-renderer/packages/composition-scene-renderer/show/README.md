# composition-scene-renderer/show

Browser-local scene snapshot renderer.

## Invariants

- DOM output is derived from `tree`, `frames`, `camera`, and `visible_edge_routes`.
- Text, component, container, and edge handling stay generic.
- Consumers register owner-surface mounters through the shared blind registry and pass that registry in `renderScene(..., { ownerSurfaceRegistry })`. `content_ref` is opaque at this boundary.
- `renderScene()` returns a lifecycle handle. Replacing, hiding, cancelling, or disposing a scene aborts active work and calls every mounted surface disposer.
- Missing, unknown, and failed owner mounts remain visible recovery states. The renderer never names a package, capability, presentation, or content variant.
- An invisible node ends its entire descendant traversal before any owner mounter runs. Nested visible nodes receive the same abort signal and disposal collection as a root node.
