# activation-pricing/show-ios-jscore source leaf

This folder owns the browserless JavaScriptCore renderer for the package.

The renderer accepts `ViewSectionModel` bytes produced upstream by
`source-leaf/view-model`. It does not import React, read projection records, use
DOM globals, or translate package terms. It exposes `bitfieldMount` for the
native JavaScriptCore bridge and emits sealed native view operations whose
action nodes carry opaque `targetRef` descriptors.

Load `render-kind-jscore.js` through `artifact_dependencies.jscore_source_paths`
before `mount-activation-pricing-jscore.js`.
