# Recipe Conformance — A Recipe IS a Native `workflow-definition` Record

A **recipe** (a content style) is NOT a new format. It is a record published at
`path: ["current-item", "published-record", "workflow-definition"]` whose payload conforms to the
engine's existing workflow-definition shape — the same shape every package action in this
package-set already uses (reference: `package::content-production::workflow-action::content-production-prompt-to-publish-intent`
in `things-to-store-and-run.json`). The engine (`slot::workflow`) runs it via `execute_definition`.
There is no second engine, no recipe compiler, and no `capability:` resolver.

## The payload shape (verified against live records)

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | `action:<name>` — how steps and submitters reference the definition |
| `kind` | yes | `"action"` |
| `name` | yes | human-stable name |
| ~~`partition_key`~~ | **no, never author it** | Assigned by the engine from the dispatch partition, which is its sole writer, so an authored value is read and discarded. Authoring one can only ever name the wrong app. Removed 2026-09-04 after this table plus the matching validator made this package fail its own rule. |
| `is_active` | no | activation flag |
| `description` | no | one line, user words |
| `input_schema` | no | `{ required: string[], properties: {...} }` |
| `steps` | yes | ordered step list (below) |

## Steps

Step kinds observed across all live package definitions: `action`, `ask`, `read`, `write`, `loop`, `return`.

- `kind:"action"` — calls another definition: `config.definition_id: "action:<x>"` + `config.inputs` (bindings).
  **This is how a recipe step invokes a capability.** Never `action:"capability:<x>"`, never a registry.
- `kind:"ask"` — asks a runtime capability: `config.name` (e.g. `compute.process`, `slot::find-current-items`)
  + **`config.input`** (the engine key is `input` — a binding usually selecting a `process_descriptor`; Round-6 finding 4).
- `kind:"read"` / `kind:"write"` — Envelope state reads/writes (`config.from` / `config.items`).
- `kind:"loop"` — iteration over a bound collection.
- `kind:"return"` — the definition's output value. A recipe's final `return` emits a
  `content-distribution.publish-intent` with ALL required fields:
  `intent_id`, `destination_id`, `artifacts[]` (each `artifact_ref` requires `multihash`),
  `metadata`, `schedule`, `requested_at` (verified `content-distribution` contract).

## Bindings

A dynamic value is `{ "$kind": "binding", "select": { "from": <source>, ... }, "transform"?: [...] }`.
Sources observed live: `input`, `steps` (with `key` naming an earlier step id + `path` into its output),
`context`, `loop`. A `steps` binding may only reference a step that appears EARLIER in the list —
the validator rejects forward references (the DAG-cycle check expressed in the native shape).

## Validation

`do-work/validate-recipe.mjs` asserts conformance. It validates the ENGINE's existing shape;
it defines nothing new. Run its tests: `node --test do-work/__tests__/validate-recipe.test.mjs`.

| Check | Rejects |
|---|---|
| payload kind | anything but `kind:"action"` |
| required fields | missing `id` / `name` / `steps` |
| step kinds | a `kind` outside the engine's step vocabulary |
| action steps | missing `config.definition_id` |
| ask steps | missing `config.name`; a `config.process_descriptor` key (must be `config.input`) |
| bindings | malformed `$kind:"binding"` (no `select.from`) |
| step references | a `steps` binding whose `key` names a missing or LATER step (forward/cyclic dependency) |
| enums | any style/capability/platform enum in `input_schema` (grep-level check — recipes carry zero closed vocabularies) |
