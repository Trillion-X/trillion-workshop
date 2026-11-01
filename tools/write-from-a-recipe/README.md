# tools/write-from-a-recipe/

The person's own AI writes the words. This folder gives it the exact instruction to write from, built from a writing recipe and the person's material, and checks what it wrote against the same recipe before the writing goes anywhere. It also keeps ready recipes (summarize, translate, rewrite, critique, plan and more) and instruction blocks a recipe can use. Nothing here asks any AI to write, and nothing here sends or stores anything: an accepted writing comes back as one request for the next tool the recipe names.

Ported from bitfield-packages `packages/content-generation` (its recipe composer and its fail-closed gate with the handoff builder), `packages/content-actions` (its AI content actions, now writing recipes) and `packages/ai-instruction-blocks` (its generic instruction blocks). The old dispatch to an AI producer, the work queue and the screens were not carried.

## Tools

| Tool | What it does |
|------|--------------|
| `tool:compose-a-writing-instruction` | A recipe (kept, by `recipe_id`, or the caller's own) plus `work_item`, `grounding` and the person's own `blocks` becomes `instruction_text`, with the recipe's `output_schema`, `gate_policy` and `delivery_target`. |
| `tool:check-writing-against-its-recipe` | The writing against the recipe: source checks, judge-words rules, required reviews, then `delivery: { tool_id, input }` (or null). Recipes may opt into `source-backed-claims/v1` to bind exact source editions, quotes, claim scope, the current draft and attributed semantic review. Attribution is explicitly unverified; rights metadata does not authorize publication. A refusal has `reject_code`, `reason` and no delivery. |
| `tool:check-writing-file` | Reads a bounded request JSON file inside the person's granted folder, applies optional recipe overrides, and returns the same gate result without returning the source file. |
| `tool:list-writing-recipes` | The kept recipes (with the answers each asks for) and instruction blocks, found by words or section. |

## Files

| File | Purpose |
|------|---------|
| `package.json` | Declares this packed package folder as an ESM scope, so the native run does not inherit a package scope above its private tree. |
| `read-data/compose-instruction.mjs` | `composeRunRequest`: renders a recipe's `instruction_plan.prompt_template`. Copied from content-generation `compose-run-request-lib.mjs`; the one change is the `{ line: [...] }` segment. |
| `read-data/check-writing.mjs` | `evaluateGate` (the source checks), `requiredVerdictsMet`, `buildOwnerDelivery` (the handoff, with a derived summary and body). From content-generation `gate-and-build-owner-delivery-lib.mjs` and its command. |
| `read-data/evidence-contract.mjs` | Optional source-backed claim validation. Reuses `content-identity` BLAKE3 identities and `judge-words` exact UTF-8 source-span coverage. It binds the review but cannot authenticate a reviewer, establish semantic truth, verify licences, or grant release authority. A strict delivery must map `evidence_provenance: { from: "context", field: "evidence_provenance" }` to the next owner; it carries rights metadata but omits source bytes and quotes. |
| `read-data/library.mjs` | The kept recipes and blocks, `recipeOf` (own recipe or `recipe_id`), `workItemOf` (fills field defaults, refuses a missing required field) and `blocksWith` (the person's blocks replace kept ones by id). |
| `read-data/writing-recipes.json` | The ready writing recipes (summarize, translate, rewrite, critique, plan and more), converted from content-actions' action rows. Only recipes any person can use are kept; a method one person follows (a research workflow, a house style) is that person's own recipe, handed in as `recipe`. |
| `read-data/instruction-blocks.json` | Generic starter blocks only: `plain-language`, `cite-sources`, `stay-on-task`, `show-your-work`, `ground-every-claim`, `remove-ai-writing-tells`. A person's own voice and sales rules are their own blocks, handed in through `blocks` (see `blocksWith`) and replacing a starter with the same id. |
| `do-work/compose-a-writing-instruction.mjs` | The compose tool's command. |
| `do-work/check-writing-against-its-recipe.mjs` | The check tool's command; packs `tools/judge-words` for rule rows. |
| `do-work/check-writing-file.mjs` | Reads a request JSON file under the explicit folder grant, then calls the same `checkWritingAgainstItsRecipe` function. |
| `read-data/write-file-limits.json` | The maximum request file size, in bytes. |
| `do-work/list-writing-recipes.mjs` | The list tool's command. |
| `tool-rows.json` | The three rows. |
| `part.json` | The composer and the gate are public, so another tool may build or check writing the same way. |
| `test/compose-a-writing-instruction.test.mjs` | Segments, blocks, input references, defaults and refusals. |
| `test/check-writing-against-its-recipe.test.mjs` | Citations, judge-words rows, fail-closed check kinds, required verdicts, the handoff and the derived body. |
| `test/check-writing-file.test.mjs` | File boundaries, byte limits, malformed JSON privacy and delegation to the existing gate. |
| `test/rows-and-library.test.mjs` | Each row's sample as the container runs it; every kept recipe composes; the DATA names nobody. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| Writing recipe | `{ id?, label?, instruction_plan: { prompt_template }, ai_producer_target?: { output_kind }, output_contract?: { schema }, context_retrieval?: { input_refs_field }, work_item?: { required, fields }, gate_policy?, delivery_target? }` | Everything about one kind of writing, as DATA. |
| Segment | text, `{ literal }`, `{ block_ref }`, `{ slot: "work_item", path }`, `{ slot: "schema" }`, `{ slot: "grounding", label }`, `{ slot: "conditional_grounding", when_present, when_absent }`, `{ slot: "conditional_value", path, when_present, when_absent }`, `{ line: [segments] }` | Segments are joined by a new line; a `line` joins its parts with nothing between them. |
| `gate_policy` | Ordinary fields: `{ grounding_id_field?, citation_specs?, checks?, grounded?, min_excerpts?, cite_or_reject?, rules?, words?, required_verdicts? }`. Optional `evidence_contract: "source-backed-claims/v1"` activates the exact packet/review shape below. | Ordinary recipes remain unchanged. Strict contract is opt-in and fails closed on mismatched editions, duplicated origins, claim/scope changes, stale review bindings, incomplete verdict coverage, invalid quote bytes, or unsafe raw HTML. |
| Evidence packet | `{ schema: "source-backed-claims/v1", sources: [{ ref, edition_id, origin_ref, source_text, content_identity, rights }], claims: [{ ref, version_id, text, scope, evidence_refs: [{ source_ref, edition_id, content_identity, relation, quote: { ref, source_start_byte, source_end_byte, source_literal, destination_start_byte, destination_end_byte, destination_literal } }] }] }` | `content_identity` must match exact source bytes. Each writing claim must match its packet version, text and scope, and name the same source refs. `rights` is retained as metadata; it does not prove permission. |
| Strict writing and review | Writing: `{ draft_text, claims: [{ ref, version_id, text, scope, source_refs }] }`. Review: `{ accepted, attribution: { reviewer_ref, method }, binding: { draft_identity, claim_set_identity, source_set_identity, claims: [{ claim_ref, claim_version_id, claim_identity, scope_identity }] }, verdicts: [{ id, accepted, claim_ref, claim_version_id, claim_identity, scope_identity, draft_identity, claim_set_identity, source_set_identity, rationale }] }` | A first refused check returns `review_binding` with the exact IDs the semantic reviewer needs to cover. Each required verdict reviews every current claim. The reviewer label and method remain caller-attributed, unauthenticated input. A successful check is a bound semantic-review assertion, not a mechanically proven meaning or authenticated identity. |
| `delivery_target` | `{ tool_id: "tool:...", input: { key: { value } \| { from: item \| work_item \| context \| derived, field } }, summary_from?, body_render? }` | `derived.summary` is the first text of `summary_from`; `derived.body` is `body_render`'s blocks, FAQ and structured data, each wrapped by `body_render.wrap` (`heading`, `text`, `question`, `structured_data`: `[before, after]`) and escaped as HTML only with `escape: "html"`. |

## Dependencies

**Depends on:** `tools/judge-words` (`do-work/judge-words.mjs`, packed by the check row), `tools/content-identity` (`read-data/identity.mjs`), `@noble/hashes` and Node 24. Existing recipes do not activate the source-backed contract unless their DATA opts in.

**Depended on by:** nothing yet; a tool that keeps or posts writing is named by a recipe's `delivery_target`.
