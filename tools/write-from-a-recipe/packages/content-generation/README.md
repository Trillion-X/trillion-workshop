# content-generation

Blind interpreter of a `content-generation.recipe` (DATA): compose an instruction, dispatch it to `ai-records-producer`, fail-closed gate the output, then build one request for the caller-selected owner action. It owns no domain, prompt, model call, record body, or destination identity.

## Files

| File | Purpose |
|---|---|
| `things-to-store-and-run.json` | Contract, recipe/run/dispatch-request records, `content-generation.run` and queue-drain actions, and stored script bytes. |
| `do-work/process-scripts/compose-run-request.py` | Renders `instruction_plan.prompt_template` DATA into an AI-production request. |
| `do-work/process-scripts/gate-and-build-owner-delivery.py` | Fail-closed gate plus a validated `{definition_id,input}` handoff. It never writes a destination record. |
| `do-work/process-scripts/drain-next-work-item.mjs` | Bounded queue pump that creates one deterministic, create-only owner-action request per work item. |
| `do-work/prepare-question-work-item.mjs` | Pure, tenant-neutral admission check for an owner-resolved audience question. It requires a current accepted review, exact evidence revisions, the selected recipe, answer-usable rights-cleared grounding when the recipe needs it, and a draft-only delivery state. It builds one create-only queue write; it does not publish content. |
| `do-work/prepare-observed-question.mjs`, `do-work/intake-observed-question.mjs`, and `do-work/process-scripts/intake-observed-question.mjs` | Convert an existing observed-content atom into current, venture-scoped candidate and customer-language evidence records using a cleared source route in DATA. Exact question wording must occur in the observation. The selected-app action writes both records create-only and reads them back. This is question evidence, not factual grounding or query-volume evidence. |
| `do-work/admit-question-work-item.mjs` | Generic owner-operation core for an injected request session; rejects conflicting reviews, writes create-only, and reads back pending work. |
| `do-work/prepare-question-review.mjs`, `do-work/review-question.mjs`, and `do-work/process-scripts/review-question.mjs` | Pure decision, owner-operation core, and selected-app workflow process for one accepted or rejected candidate revision. Acceptance checks evidence, grounding, recipe, and duplicates. A decision is create-only and read back; a correction requires a new candidate revision. Actor attribution is omitted until a trusted context source exists. No person-facing review surface or installed action has been proven. |
| `do-work/prepare-question-grounding-link.mjs` and `do-work/process-scripts/link-question-grounding.mjs` | Advance a candidate revision only when a separate current answer-evidence row already has cleared reuse rights, source-linked excerpts, and the same venture and partition. The workflow requests the generic query's current `content_hash`, converts it through `live-namespace` to the write owner's compare-and-set basis, and verifies readback. It cannot confer rights or publish. |
| `do-work/process-scripts/admit-question-work-item.mjs` | Pure prepare/readback process for the declared native workflow action. Workflow reads and writes the selected app; no carrier URL is requested from a person or agent. |
| `tests/test_content_generation.py` | Generic compose, gate, and owner-delivery unit tests. |
| `tests/gated-owner-delivery.test.mjs` | CLI-level owner-delivery contract test. |

## Key actions

| Symbol | Role |
|---|---|
| `action:content-generation.run` | resolve instruction blocks → compose → ask `ai-records-producer` → gate → return the caller-declared owner handoff |
| `action:content-generation.drain-next` | enqueue a deterministic generic run request; trigger delivery invokes its opaque owner action separately |
| `action:content-generation.admit-question-work-item` | Read current candidate/review/evidence/answer/queue records, admit one reviewed pending question by create-only write, then verify current readback. Inputs: `partition_label`, `venture_ref`, `candidate_id`. Does not publish. |
| `action:content-generation.intake-observed-question` | Read a current observed-content atom and matching cleared DATA route, then create a reviewable candidate and evidence. Inputs: `source_atom_ref`, `route_id`, `question`. Does not review, queue, or publish. |
| `action:content-generation.review-question` | Read current candidate/evidence/recipe/answer/queue/review records, accept or reject one candidate revision by create-only write, then verify current readback. Inputs: `partition_label`, `venture_ref`, `candidate_id`, `verdict`, `reason`. Does not publish. |
| `action:content-generation.link-question-grounding` | Read one current candidate and answer-evidence row, link only independently cleared grounding with a compare-and-set write, then verify the new candidate revision. Inputs: `partition_label`, `venture_ref`, `candidate_id`, `evidence_id`. Does not clear rights, review, or publish. |
| `content-generation.recipe` | DATA contract: instruction plan, AI target, output schema, gate policy, and required `delivery_target` |

`delivery_target` is `{definition_id, input, summary_from?, body_render?}`. Every input value is derived only from generated item data, work-item data, supplied context, or recipe literals. The selected owner validates and stores its own body.

## Invariants

- Rejected output exits non-zero and creates no owner handoff.
- Accepted output has exactly one owner handoff; it has no `write_item`, address, path, or standalone destination payload.
- Content Generation has no article, publishing-channel, or destination-specific code path.
- Queue idempotency is the immutable dispatch request. A destination owner owns its own content identity and duplicate policy.
- A question candidate is not search demand merely because it names a public page. The admission preparer keeps venture identity and source revision on the pending work item and refuses a public-page row as proof of query volume. Its current source proof does not mean an admission action or UI is installed.
- Observed-question intake requires `content-generation.question-source-route` DATA with `question_use_status: cleared`, an explicit evidence kind (`customer_language`, `public_page`, or `first_party_query`), and exact source, venture, partition, audience, locale, recipe, and offer refs. The source atom must carry current `authorized` source authorization for that exact partition and a scope reference; a route cannot move someone else's observed text into a different venture. Its evidence retains the source kind with `supports_answer: false` and `rights_status: not_cleared`; a public page is never silently treated as measured search demand. A separate, rights-cleared factual source must be attached before accepting a grounded article review. Intake is not discovery of all questions in a source and is not a person-facing review surface.
- A search-query observation is not a factual source for an answer. Grounded recipes require separate candidate `grounding_refs` whose current evidence rows explicitly allow answer use, carry cleared rights, and contain source-linked `{ref,text,source_ref}` excerpts. Admission copies those excerpts onto the queue row and enforces the recipe's minimum. The pump forwards them to the generation and citation gate, and refuses grounded legacy rows with only source refs. The selected recipe must exist, its work-item fields must be supplied, and its declared delivery state must remain a draft or pending review.
- Grounding cannot bypass the link action by pre-populating candidate refs: review and queue admission also require an explicit rights-basis reference, a separate answer-source observation, and an answer-capable evidence kind. A nonempty rights-basis reference is not itself proof of permission; the producer of that evidence must independently establish the rights decision.
- A reviewed queue row's `recipe_ref` takes priority over cadence `CONTENT_RECIPE_REF`; the cadence remains a legacy fallback. The pump refuses a missing selected recipe before dispatch. Optional nonnegative finite asset/resource/cost estimates are carried from the reviewed candidate; finite limits keep missing estimates pending rather than guessing.
- Question admission checks that the candidate, accepted review and evidence name the selected partition and venture. A caller cannot retarget a valid candidate into another tenant's partition.
- `action:content-generation.admit-question-work-item` is declared and its source bundles. The selected-app workflow no longer needs a carrier URL, but this is not proof of live installation or UI/agent parity. A generic candidate-review surface and live owner readback remain necessary.
- Queue admission applies DATA-selected in-flight, daily asset, resource-unit, and cost ceilings before the create-only dispatch claim. One authentic take may declare N selected outputs; throughput counts those outputs, never manual recordings or public posts.
- Workflow processes never synchronously call Workflow; the trigger engine dispatches durable handoffs on its independent stream.
