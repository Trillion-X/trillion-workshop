# show

This folder owns the renderer-agnostic surface descriptor for `plan-lifecycle`.
The descriptor is a package-owned contract over the generic record-work model.
Renderers may switch only on `SectionKind`; all user labels, tones, disabled
reasons, and action text are data copied through the descriptor.

`plan-lifecycle-surface-descriptor.ts` imports no React and contains no
status-specific branches. Browser, desktop, and iOS JSCore surfaces consume this
same descriptor shape.
