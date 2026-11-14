# content-actions

Durable DATA home for the cross-surface library of AI content actions (Summarize, Translate, Rewrite, Analyze, Transform, …), each an `action-affordance` published-record surfaced by channel to any consuming package.

## Files

| File | Purpose |
|------|---------|
| `things-to-store-and-run.json` | The admitted DATA. Mostly `action-affordance` records (`package::content-actions::action-affordance::<slug>`, path `[current-item, published-record]`), and ALSO `workflow-action` records the package owns (`package::content-actions::workflow-action::<slug>`, path `[current-item, published-record, workflow-definition]`), including `run-recipe-for-request`, which resolves a `content-generation.recipe` record by id and dispatches the blind interpreter `action:content-generation.run`. Still no source handler: a workflow action is DATA too, steps and bindings rather than code. **This row used to say "77 action-affordance records" and that was wrong in two ways at once**: the count rots on every added row, and it described the file as affordances only while workflow-action records were already in it. A README says WHAT a file holds; counts belong in a knowledge leaf where they can be corrected in place. |
| `things-contract.test.ts` | Conformance contract for the DATA (vitest): every record decodes through the real reader; every record reaches all three surface doors (`composition.slash-menu`, `group.add-shelf`, `group.palette`); per-record triggers are byte-identical modulo id/channel (one behavior, N doors); `trigger.id === channel` (dispatch resolves by id); addresses stay in the package namespace; every record carries a `section`. |
| `README.md` | This file. |

## What this package is

`content-actions` owns **no code**. It is a pure-DATA package: a set of `action-affordance` records that configure the ONE blind action-affordance engine. Every action is a single DATA row over that primitive — adding an action is one record, zero code (L069/L090/enum-dissolution). `Create article` is the proof action: its request, destination selector, steps, preview, advanced settings, and Envelope workflow target are all record data; it does not generate or publish content in this package. The retired `To blog post` row is removed from the active set.

Records are surfaced **by channel string** (`composition.slash-menu`, `group.add-shelf`, `group.palette` — the board ⌘K command palette, added 2026-07-10). Any consumer that calls `affordancesForChannel(itsChannel)` inherits every matching action for free — consumers do NOT import this package; they read the `published-records` feed and filter by channel (decoupled). Per record, the channel triggers are byte-identical modulo `id`/`channel` (one behavior, N doors) — enforced by `things-contract.test.ts`. A design that collapsed triggers to a `channels[]` array was adversarially audited (Codex 2026-07-10) and rejected: `trigger.id === channel` is dispatch-load-bearing (`buildDispatchPayload` resolves by id and falls back to `triggers[0]`), and a multi-channel trigger would break the edit path's keep-verbatim byte-intact contract.

## Record shape (per action)

- `kind: 'action-affordance'`, `id: 'action-affordance:content:<slug>'`, `label`, `section` (slash-menu group header), `is_active`.
- `triggers[]`: one per channel; each carries `input_template` (bindings) and optional `ask.fields` (multi-field form, e.g. `rewrite-with-options`).
- `dispatch`: `target: 'slot::workflow'`, `payload_template.definition_id: 'action:run-ai-records-production'` (the generic AI records producer — NOT a re-owned model/provider; the AI substrate is invoked by address), `status` at the label-hash producer result address.

## Substrate reused by address (no god package)

- **AI invocation** → `ai-records-producer` (`action:run-ai-records-production`).
- **Prompt/skill** → `ai-instruction-blocks` (form fields via `options_address: 'ai-instruction-block'`).
- **Model/provider** → `ai-providers` / `ai-model-descriptor` (form fields via `options_address`).

This package re-implements none of them; it only stores the action DATA that dispatches to them.

The design-taste action is the same DATA recipe as every other action: its form collects a
URL and crawl scope, its template invokes the generic AI producer, and its returned Markdown
is placed by Documents's existing result-artifact rail. YouTube is a valid input
example, not a special case or a destination branch.

## Dependencies

**Depends on:** nothing at compile time (pure DATA). At runtime the dispatched actions rely on `ai-records-producer` (execution); multi-field forms resolve options from `ai-providers` / `ai-instruction-blocks` by address.

**Depended on by:** `documents`, `group`, `vision-board` (and any package surfacing the `composition.slash-menu` / `group.add-shelf` channels) — all via the `published-records` feed + channel filter, never by import.

## Notes

- The `image-generation` action is intentionally NOT in this durable set: its `dispatch.definition_id` is still hardcoded to a single image backend (audit violation #2 — the backend must be a DATA choice bound to `answers.backend`, ideally with fields derived from the selected backend def's `input_schema`). It stays live-log-only until that violation is fixed, then folds here. Folding a known-violation record into durable source violates L075.
- Regenerated from the live log (SSOT) via `bitfield-runtime-kit/references/background-runner-shell/scripts/_dump-content-actions-things.mjs`.
