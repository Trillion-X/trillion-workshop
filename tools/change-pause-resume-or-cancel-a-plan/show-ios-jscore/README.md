# show-ios-jscore

`mount-plan-lifecycle-jscore.js` is the JavaScriptCore native snapshot renderer
for `plan-lifecycle`. It consumes `PlanLifecycleSurfaceDescriptor`, which is
produced by `show/plan-lifecycle-surface-descriptor.ts`, and emits sealed
`native.view.snapshot.*` operations.

This folder does not own plan state, action availability, labels, tones, or
confirmation meaning. Those are descriptor data. The JSCore renderer only
matches the Physics-closed section kind contract and sends action ids through
`screen.mount.action`.
