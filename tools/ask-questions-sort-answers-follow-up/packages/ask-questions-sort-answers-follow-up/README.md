# ask-questions-sort-answers-follow-up

Ask people questions, capture their answers as facts, decide a segment from data rules, and run a per-segment follow-up — one package over the `composition` + `eeaf` + `workflow` substrate (no second renderer, no closed enums).

## Files

| File | Purpose |
|------|---------|
| `things-to-store-and-run.json` | Package boundary file (old engine packaging): its surface, entry, contract and workflow records. It holds no question types: the builder and the fill surface read `data/question-types.json`, the one types file the server's check and the step pages read. |
| `read-data/validate-answer.ts` | Pure, framework-agnostic answer coercion + validation driven by the capability's `validate.rules` DATA. Generic — never enumerates question types. |
| `read-data/validate-answer.test.ts` | 11 vitest cases (coerce string/number/boolean, required/optional, string-length bounds, pattern, number-value bounds). |
| `read-data/question-input-contract.ts` | The shared `QuestionInputProps` every input leaf implements. |
| `read-data/question-descriptor.ts` | DATA shapes: `QuestionDescriptor`, `QuestionTypeCapability` (registry row), `QuestionSequence` (a form), `indexCapabilities`. |
| `read-data/question-suggestions.ts` | Pure resolver for DATA-bound current-feed suggestions/options (`QuestionFeedBinding` → blind path/predicate extraction). No producer knowledge, NO fallback constants: absent/stale/malformed/unauthorized feeds render nothing. |
| `read-data/fill-screen-model.ts` | Pure capture-stage orchestration: descriptors + registry + answers → render rows (resolved inputComponentKey/coerce/merged rules/value/error) + `allValid`/`firstInvalidId`. Generic; no question-type enumeration. |
| `read-data/fill-screen-model.test.ts` | 7 vitest cases (registry resolution, deferred-vs-revealed errors, bounds, graceful unknown-type fallback). |
| `read-data/read-forms-data.ts` | Decodes raw bitfield input entries (`useBitfieldData` output) → typed `QuestionTypeCapability[]`/registry + `QuestionSequence[]`. Defensive: drops malformed/foreign rows. |
| `read-data/read-forms-data.test.ts` | 7 vitest cases (wrapped+bare rows, coerce defaulting, indexing, descriptor/option decode, null-safety). |
| `do-work/answer-fact-writes.ts` | Pure builders: captured answers → one addressable EEAF `answer-fact` per question (§7.3) wrapped in an engine write-batch request. |
| `do-work/answer-fact-writes.test.ts` | 4 vitest cases (addressing, one-fact-per-answer, write-batch envelope, empty submission). |
| `do-work/submit-answers.ts` | I/O wrapper: `submitAnswers` persists the facts via `sendRequestToBitfieldTarget`. |
| `read-data/score-and-segment.ts` | DECIDE stage (pure): DATA-driven scoring (`ScoreRule` matchers value_map/equals/gte/lte/min_length/contains/has_value) + segment assignment (`SegmentRule` thresholds). No hardcoded weights/archetypes — a "hot" lead is a rule row (L063/L090). |
| `read-data/score-and-segment.test.ts` | 7 vitest cases (each matcher, breakdown + named buckets, tier thresholds, decide()). |
| `read-data/follow-up-sequences.ts` | ACT stage (pure): per-segment follow-up sequence DATA (steps name external-executor venue configs + a time gate; keys in vault) + `selectFollowUpSequence` + decoder. |
| `read-data/follow-up-sequences.test.ts` | 4 vitest cases (select by segment, null cases, decode + drop malformed). |
| `do-work/segment-assignment-writes.ts` | Pure builders: the DECIDE outcome (segment + score + breakdown) → one addressable EEAF `segment-assignment` fact in an engine write-batch. |
| `do-work/segment-assignment-writes.test.ts` | 3 vitest cases (addressing, fact shape, write-batch envelope). |
| `read-data/read-decide-config.ts` | Decodes score-rule + segment-rule + follow-up-sequence rows from the published-records aggregate into one `DecideConfig` (canonical type). |
| `read-data/read-decide-config.test.ts` | 5 vitest cases (decode each kind, drop malformed, null-safe). |
| `do-work/process-submission.ts` | Pipeline integration point: on submit, ONE atomic write-batch (answer facts + segment-assignment) + returns the selected follow-up. `buildProcessSubmission` (pure) + `processSubmission` (I/O). |
| `do-work/process-submission.test.ts` | 4 vitest cases (atomic batch composition, decision+follow-up, empty submission). |
| `read-data/builder-model.ts` | FB-7 builder data layer (pure immutable): newQuestion/newQuestionSequence/add/remove/update/move/setTitle on a draft form. |
| `read-data/builder-model.test.ts` | 7 vitest cases (append, immutability, remove, patch, reorder+clamp, no-op, setTitle). |
| `do-work/save-question-sequence.ts` | Persist a draft as one `question-sequence` record — the SAME record the fill side reads (L097 one write path). |
| `do-work/save-question-sequence.test.ts` | 4 vitest cases (addressing, record shape, write-batch, round-trip decode via fill reader). |
| `show/inputs/QuestionField.tsx` | Label + control + error wrapper (composes ui `Container`+`Text`). |
| `show/inputs/TextInput.tsx` | Free-value leaf (ui `Input`). |
| `show/inputs/ChoiceInput.tsx` | Bounded-choice leaf (ui `SegmentedControl`). |
| `show/inputs/RatingInput.tsx` | Scalar leaf (ui `SegmentedControl`, numeric scale from DATA bounds). |
| `show/inputs/index.ts` | The owner-provided `inputComponentKey → leaf` capability map + `resolveInputComponent` (L090 dispatch; no switch). |
| `show/FillSurface.tsx` | The CAPTURE surface — thin React consumer of `buildFillScreenModel` + `resolveInputComponent`. Owns only answer state + reveal-on-submit. Full render-state matrix (loading/error/submitted/empty/questions); composes ui only. |
| `show/FillSurface.test.tsx` | 7 RTL cases (render-state matrix + submit gating: blocks on invalid + reveals error, submits coerced answers when valid). |
| `show/inputs/resolve-input-component.test.ts` | 6 vitest cases (map binds 3 seeds, resolves each, falls back to text, scale builder). |
| `show/BuilderSurface.tsx` | The builder — a DATA editor over `builder-model` with a live `FillSurface` preview. Add/edit/reorder/remove questions, Save persists the same record the fill side reads. Composes ui only; render-state matrix. |
| `show/BuilderSurface.test.tsx` | 4 RTL cases (empty draft + disabled save, add-gating, add shows in editor+preview, save calls onSaved). |
| `read-data/results-model.ts` | FB-8 results projection (pure): decode segment-assignment facts → respondent rows + per-segment summary (data-driven, newest-first). |
| `read-data/results-model.test.ts` | 5 vitest cases (decode+filter, drop malformed, summary buckets, newest-first, honest-empty). |
| `show/ResultsSurface.tsx` | The operator's results view — StatStrip + Table + Badge over ResultsModel. Honest-empty; segment chips DATA-driven; zero inline styling. |
| `show/ResultsSurface.test.tsx` | 2 RTL cases (honest empty, row-per-respondent + summary). |
| `README.md` | This file. |

## Key Records (current)

| Record (`payload.kind`) | Address | Role |
|---|---|---|
| `question-type-capability` (text) | `package::ask-questions-sort-answers-follow-up::question-type-capability::text` | Maps `questionTypeId:"text"` → `inputComponentKey:"text"`, validation DATA, `coerce:"string"`. |
| `question-type-capability` (choice) | `…::question-type-capability::choice` | Bounded-choice input; reuses per-question `options` DATA; `coerce:"string"`. |
| `question-type-capability` (rating) | `…::question-type-capability::rating` | Scalar 1–5 input; `coerce:"number"`. |

Each capability row is DATA. The fill-surface handler dispatches `registry.get(questionTypeId) ?? fallback` — it NEVER enumerates question types (enum-dissolution / L090). Adding a new question type = ship one `show/inputs/<key>.tsx` leaf + one `question-type-capability` row; ZERO renderer/dispatcher code change. This replaces the dying closed union `FormField.type` (12 variants, deleted).

## Architecture (how a form renders without a second renderer)

A form is stored as a `composition` scene (questions = `SceneNode`s). The composition renderer (`composition-engine/source/assets/render_scene.js`) renders the scene; the fill SURFACE is ONE mounted package component whose handler reads the `question-type-capability` registry and renders each question's input via a DATA-read `inputComponentKey → leaf component` map. `validate`/`options`/`conditional` stay as DATA on the question node (reused from the earlier form shapes, not redesigned). Answers are EEAF `attribute_fact`s keyed `(formId, respondentId, questionId)` — addressable, so DECIDE-stage workflows read exactly what changed.

## Dependencies

**Depends on:** `composition-engine` (scene renderer, Component-node seam), `eeaf` (answer facts), `workflow` (score/segment/follow-up definitions), `ui`/`screen-look` (input leaf components, zero inline styling).
**Depended on by:** audience-segmentation funnels that replace an app-local form builder.

## Build status

Consolidation source update: generic number inputs accept decimals and preserve empty answers. Source inputs return bounded JSON-safe references through a containing owner's callback, sharing the draft identity with final answer writes. Source selection is not access permission; this package does not choose a connection or verification workflow. Current DATA-driven suggestions remain intact. All 34 declared test suites pass, and package entry bytes are rebuilt. This is local source validation, not a runtime deployment claim. Practice-session regression fixtures live under `__tests__/fixtures` to remove machine-specific cross-repository test paths.

Per plan `2026-06-25-forms-and-audience-sorting-architecture` (spec `per-task-specs/FB-2.md`):
- **FB-2 / FB-4 CAPTURE — DONE + DEPLOYED LIVE to bitfield-studio:** registry + validate-answer + 3 input leaves + L090 dispatch map + fill-screen-model + FillSurface (render-state matrix) + decoders + answer-fact writes + the deploy-ready records (placeable-surface/entry/input-descriptor/factflow) + mount + AskQuestionsView. Importer build+deploy `ok:true` → `entry-bytes` 2.7MB live in the studio partition log (`readCurrent`-confirmed).
- **FB-5 DECIDE — DONE:** `score-and-segment.ts` pure DATA-driven scoring + segmentation.
- **FB-6 ACT data layer — DONE:** `follow-up-sequences.ts` (per-segment follow-up select + decode) + `segment-assignment-writes.ts` (record the decision as an EEAF fact).
- **FB-6 integration — DONE:** `process-submission.ts` (atomic CAPTURE+DECIDE+ACT on submit) + `read-decide-config.ts` decoders; AskQuestionsView now runs the full pipeline on submit.
- **FB-7 builder — DONE:** `builder-model.ts` (immutable draft ops) + `save-question-sequence.ts` (L097 one write path) + `BuilderSurface.tsx` (data-editor with live FillSurface preview, render-state matrix, zero inline styling).
- **Tests:** 79 pass (14 files). Full ASK → CAPTURE → DECIDE → ACT + author(builder), framework-agnostic.
- **Remaining:** author the follow-up workflow-def DATA records + external-executor venue configs (CRM/email/Discord, keys in vault) + wire `decide → record → follow-up` on answer-fact write; FB-7 builder surface; FB-9 retire the app-local Tally/N8N once parity proven. Last-mile for visual render: studio clean reboot + in-app surface-picker placement.
