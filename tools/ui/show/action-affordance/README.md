# action-affordance/

Pure decode, filter, binding resolution, view-model mapping, record building, and an authoring modal for `kind:"action-affordance"` published records — DATA that shows/invokes an existing admitted workflow action from named render contexts. Execution stays with the workflow slot; output placement stays with each invoking surface; this folder is I/O-free (hosts inject senders and own reads/writes).

## Files

| File | Purpose |
|------|---------|
| `action-affordance-types.ts` | Record + invoke-context types, including schema-driven configuration steps, advanced groups, previews, and live option-source/default metadata. |
| `read-action-affordances.ts` | Tolerant decode of published records, generic configuration seeding/validation, last-used configuration folding, channel filtering, binding resolution, and dispatch payload building. |
| `render-action-items.ts` | Rows → `CommandPaletteItem[]` / `NodeActionCapability[]` via a caller-injected invoke. |
| `write-action-affordance.ts` | Authored draft → publishable record + addressed write item (host sends); the builder INVERSE (`draftOfActionAffordanceRecord`) and the FIELD-PATCH edit item (`buildActionAffordanceEditWriteItem`) for edit-in-place. |
| `write-affordance-live.ts` | Live write paths (injectable sender): actions, presets, generic last-used configuration records, and the ONE liveness primitive `setActionAffordanceActiveLive`. |
| `action-preset.ts` | "Save as preset": curry filled answers into a base record's triggers (`deriveActionPresetRecord`) — a specialized action published through the SAME user-actions write path. |
| `ActionAffordanceEditor.tsx` | "New action" / "Edit action" modal emitting a draft; prefills from `initialDraft` (edit-in-place); runnable/channel options are caller DATA; "Menu group" section field. |
| `ActionForm.tsx` | The blind schema-driven configuration form: renders any field descriptors, arbitrary steps/groups/previews, and injected control renderers; domain-blind (L090). |
| `EntityPickerField.tsx` | Record-picker field control for `ask.fields` — options from a published-records address. |
| `index.ts` | Barrel export. |
| `action-affordance.test.ts` | Decode tolerance, channel/conditions filtering, binding resolution, deletion test (3 unrelated DATA domains), dispatch build, live/archived partition truth table. |
| `render-action-items.test.ts` | Palette/node-action mapping + invoke dispatch. |
| `write-action-affordance.test.ts` | Record/write-item golden shapes, slug determinism, draftOf round-trip law, FIELD-PATCH edit contract (form triggers survive rename byte-intact). |
| `write-affordance-live.test.ts` | Live write reply decoding (u64 LE / JSON / object), liveness-primitive payload proofs, verb delegation. |
| `ActionForm.test.tsx` / `EntityPickerField.test.tsx` | Blind form rendering + answer collection; entity-picker decode/selection. |
| `action-preset.test.ts` | Currying (bake answers, prune ask), preset addressing in the shared user-actions namespace. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `ActionAffordance` | `{ id, version, is_active, label, icon?, hint?, section?, priority?, accepts?, triggers[], dispatch, output_contract?, payload }` | One decoded affordance record. |
| `readActionAffordances` | `(records: PublishedRecord[]) → ActionAffordance[]` | Skip-invalid decode. |
| `affordancesForChannel` | `(all, channel, context?, placement?) → ActionAffordance[]` | Trigger-channel + conditions filter, priority sort. `placement: ChannelPlacement = { context, defaultContext }` narrows to a scope WITHIN the channel (a trigger declares `contexts: string[]`; undeclared = the host's `defaultContext`). |
| `ChannelPlacement` | `{ context: string; defaultContext: string }` | A host's placement scope within a channel — host vocabulary, open strings, never enumerated here. `triggerForChannel` accepts the same optional placement. |
| `resolveBindingTemplate` | `(template, ctx) → unknown` | Deep-resolve `{ $kind:'binding', select:{from,path} }`; literals pass verbatim; sources read generically from `ctx[from]`. |
| `buildDispatchPayload` | `(affordance, triggerId, ctx) → { target, payload }` | Resolve trigger input then dispatch payload. |
| `affordancePaletteItems` / `affordanceNodeActions` | `(rows, channel, invoke, accepts?) → renderer rows` | Blind renderer mapping. |
| `buildActionAffordanceWriteItem` | `(draft) → { address, path, payload }` | Live-write item for an authored action. |
| `draftOfActionAffordanceRecord` | `(payload, runId) → ActionAffordanceDraft \| null` | Builder inverse (round-trip law `build(draftOf(build(d))) ≡ build(d)`); a foreign template honestly decodes with NO instruction. |
| `buildActionAffordanceEditWriteItem` | `(draft, existing{id, source_address?, payload}) → item \| null` | FIELD PATCH onto the ORIGINAL payload — label/section/icon replaced, instruction patched only into builder-shaped templates, still-selected triggers kept VERBATIM, id+address preserved. NEVER a rebuild (rebuild flattens unmodeled fields — Codex 2026-07-10). |
| `setActionAffordanceActiveLive` | `(ref{id?, source_address?, payload}, isActive, partition, sender?) → address` | The ONE liveness primitive: archive (`false`) / restore (`true`) at the record's own identity address. |
| `readArchivedActionAffordances` | `(records) → ActionAffordance[]` | The `is_active:false` partition (same decoder, liveness flipped for the pass); rows keep the ORIGINAL payload so restore rewrites exactly what was archived. |
| `resolveActionAskInitialAnswers` | `(ask, context, options?, persisted?) → answers` | Generic defaults + current invoke bindings + last-used seed for the fast path. |
| `actionAskHasRequiredAnswers` | `(ask, answers) → boolean` | Structural validity gate used before immediate dispatch. |
| `readActionAffordanceConfigurations` | `(records) → actionId → answers` | Fold the latest durable last-used configuration per action. |
| `ActionAffordanceEditor` | React modal | Emits `ActionAffordanceDraft` via `onSave`; never persists; `initialDraft` prefills for edit-in-place. |

## Dependencies

**Depends on:** `command-palette` (row type), `node-actions` (capability type), `placeable-surface-intent` (`PublishedRecord`), `modal`/`button`/`container`/`text`/`input` primitives. ZERO `@bitfield/runtime-kit` — hosts own data reads, dispatch senders, and write paths.

**Depended on by:** `packages/group` (board shelf/palette/context-menu adapter), `packages/vision-board` (record-fed tools), `packages/documents` (slash-menu adapter).
