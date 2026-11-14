# Anatomy illustrations

MIT Anatomy from Ryan, pinned to upstream commit `689dcf966e63d92be10a5d593c6e19e10acd4422` at https://github.com/wheresryan22/anatomy. Downloaded `kit/iso-kit.mjs` was independently byte-compared with that immutable upstream file. Original source, license and BLAKE3 identity live in `design-systems/anatomy/`.

`iso-kit.mjs` keeps upstream geometry and SVG rendering. Its exported appearance was extracted into `parts/screen-look/show/anatomy/iso-style.mjs`. The adapted figure wrapper accepts one complete SVG body within the passive Anatomy vocabulary and an optional accessible `label`; unsupported fields, HTML, active markup and external paint references throw. Local gradients and blur filters remain supported. This boundary checks structure, not the meaning of teaching text. It has no figure number, corner labels, helper text, readout, legend or caption slots. `selector-machine.mjs` is original geometry: a detailed pick-and-place instrument, with source-card holder, tool cassettes, guide rails, a gantry picker, work bed and inspection stamp. `explainer-page.mjs` owns HTML controls and local animation; callers supply the headline, teaching sections, phases and example. Those DATA records also reject unknown fields. The same projection drives every moving part.

The build contains 68 solid parts: four feet; bed; four cassette bases, bodies, lids and connectors; two guide-rail bases and caps; two stops; source holder bottom and walls; five dividers and paper cards; work platen and three fixtures; ruler; inspection nest, pad and paper; stamp support, arm, shaft and pad; two gantry shoes, posts and caps; gantry beam and scale; picker saddle, motor, housing, shaft, grip and two jaws; and one selected card. Screw dots, seams, vents and ruled scales add purposeful detail.

The four-stage example is an explanatory metaphor. Its source qualification stays in this record rather than visible production commentary. It does not report customer activity, performance, likelihood scores or completed work. The picker releases and retracts before inspection. Reduced motion paints still states; offscreen or hidden pages stop the loop. Stage buttons support arrows, Home and End, with visible keyboard focus. The guided tour pauses during direct use.

21st.dev query `segmented control tabs` and component `23552` informed the stage-selector interaction. Its code was not copied. Mobbin tools were not exposed in this session. All drawing code reused here is MIT, with the upstream LICENSE retained.

Build: `node scripts/build-anatomy-explainer.mjs`. Live hosted control/geometry/phone checks and recording: `node scripts/prove-anatomy-explainer.mjs`. Anatomy line checks reported zero floating ends in both themes. The page's JavaScript is a same-site file because the public-app host requires `script-src 'self'`.

Originating request: Codex `msg_01a12de4-af82-7d32-a1d8-c0c388814cbf`, Trillion message `message:2026-10-12T02:15:24.290Z:2f80011bf8b762cb53f42e45`.

## Reusing figures in films and direct controls

`paint-figure.mjs` mounts a renderer's `{svg}` inside an existing host. It rejects active/external SVG, preserves the last good figure after a refusal and reuses an unchanged frame. `sequence-page.mjs` composes named visual layers and timed segments for the existing Showtime capture owner; its script references are local. Both page configurations reject unknown secondary-copy fields.

`controlled-figure-page.mjs` keeps a named native range and appearance button beside a validated figure. The figure body remains one SVG; controls cannot enter through its body. Appearance belongs in `parts/screen-look/show/anatomy`: `sequence-style.mjs`, `controlled-figure-style.mjs` and reusable `racket-materials.mjs`. The existing racket consumer uses these owners for both direct control and its film. A local demonstration is not a live learner account or a validated physical simulation.

Focused qualification: `node --test test/anatomy-sequence.test.mjs test/anatomy-structure.test.mjs` checks figure refusal, opposing teaching/accessibility content, actual physical-model states, and the browser mounting boundary. Actual consumer pixels, deterministic seeking and input behavior are separate checks.
