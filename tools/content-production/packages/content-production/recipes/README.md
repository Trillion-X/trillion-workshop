# content-production/recipes/

**Purpose:** Style/pipeline DATA companions — EDL and trigger documents consumed alongside the workflow-definitions; the definitions themselves live ONLY in `../things-to-store-and-run.json` (the SSOT — these files carry no copy).

## Files

| File | Purpose |
|------|---------|
| `style.talking-head-aroll-slides.json` | First style (T04): `{edl}` — EDL derived from the slide-windows timing SSOT (definition: record `action:style-talking-head-aroll-slides`, which chains video-grade → slides-render → video-compose → publish intent). Golden-tested against the shipped video's metrics |
| `style.audio-slides-dominant.json` | Second style (T16): `{edl_template}` — `base.kind:slides` + `replace_audio`, zero chapters (definition: record `action:style-audio-slides-dominant`). The falsification proof: pure data over the same capabilities |
| `pipeline.record-to-publish.json` | T11 automation: `{trigger}` — the delta trigger-rule (ships `is_active:false`); the pipeline definition is record `action:pipeline-record-to-publish` (classify → execute the CLASSIFIED definition) |

## Key Shapes

| Shape | Fields | Contract |
|-------|--------|----------|
| recipe / pipeline | native workflow-definition (`id`, `kind:"action"`, `steps[]`) | validated by `../do-work/validate-recipe.mjs`; conformance doc `../recipe-conformance.md` |
| edl | `base`, `spine.segments[]`, `overlays[]`, `chapter_inserts[]`, `audio_graph`, `encode` | `media-composition`'s `contract::edl` record |
| trigger | `topic:data_state`, `trigger_type:delta`, `match_condition`, `dispatch` | mirrors the verified `public-document-renderer` trigger-rule shape |

## Invariants

- A recipe IS the engine's existing definition shape — no recipe compiler, no second engine.
- Adding a style = one workflow-definition record in `../things-to-store-and-run.json` + its EDL data file here; zero capability code. ONE copy of every definition (SSOT).
- Final `return` steps emit contract-complete `content-distribution.publish-intent` values (all six required fields + artifact multihash).

## Dependencies

**Depends on:** capability action records across content-production / audio-transcription / media-composition; the timing SSOT (`~/dev/show-up-video/production/slide-windows.json`) at authoring time.
**Depended on by:** `../__tests__/golden-talking-head.test.mjs`, `../__tests__/falsification-audio-slides.test.mjs`, `../__tests__/record-to-publish.test.mjs`; the Style picker surface (U03) renders the registered records as cards.
