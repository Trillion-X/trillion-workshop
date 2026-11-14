# Diffusion Studio range slider

The exact MPL-2.0 Slider and cva source from Diffusion Studio 0.200.0 owns pointer, keyboard, focus, fill and input behavior through Solid and Kobalte. `source/slider.tsx` and `source/cva.ts` retain their original bytes and license headers. The extracted local snapshot has no upstream commit metadata; hashes in provenance identify these exact files.

`mountRangeSlider(node, {min,max,step,value:[start,end],onChange,label,disabled?,minStepsBetweenThumbs?})` mounts a domain-blind controlled range. Its return value exposes `update(partialOptions)` and idempotent `dispose()`. Each thumb includes its owner label followed by start or end. The callback receives a new two-number array. Programmatic update does not emit a user change. Invalid options throw before replacing current state. Mounting again disposes the previous mount. Minimum separation defaults to zero steps; use one for strictly positive intervals.

Appearance lives in screen-look/show/diffusion. The consumer builds through `build-diffusion-controls.mjs`; it emits an isolated Solid bundle plus styles, source manifest and a complete source-disclosure JSON including original MPL files and license. Distributors must ship this disclosure alongside the bundle and make it accessible to recipients; this local extraction does not claim a published distribution.

Keyboard delegation is attached to the Solid mount node so a surrounding React dialog cannot swallow arrow keys before Solid sees them. Only handled keys stop propagation, preserving Escape and Tab. Disposal removes the island listeners. The real shared-dialog fixture verifies a single .001 increment, Home and Escape/disposal.

Reference anatomy: horizontal track, selected fill and two round thumbs, label/value above. Preserve supplied source classes and all Kobalte interaction mechanics. Integration adds lifecycle and responsive theme scope only. Fixtures cover keyboard, pointer, updates, disposal, narrow screen and reduced motion. No original product before screenshot is claimed; parent owns actual app integration and its visual comparison.
