# workflows

Shared playbooks that any person's AI can follow step by step. Each playbook is one recipe file in `recipes/`; the workflow engine that runs them is arriving here from `crates/workflow-engine` in the main Trillion repository. If that engine ever needs bounded replay (host-owned limits on definitions, steps, loops and action depth, checked against the usage it reports), start from commit `5c340ea748` ("preserve bounded workflow replay"), kept in the main Trillion repository's `shipped/app-202610301249` branch history; it was left out of main because nothing called it.

## Files

| File | Purpose |
|------|---------|
| `read-data/recipe-problems.mjs` | The recipe validator: `recipeProblems(row)` names every problem with a `workflow-recipe` row at once (id, job, input schema, steps, tool calls and pins, checks, actor policy, or a written `definition`). A recipe with no problems can be run by any account. |
| `recipe-check-kinds.json` | The check vocabulary as DATA: the roots a path may start at, the catalogs `exists` may name, and one row per check kind with its meaning, the fields it takes (shape, required, refusal words) and any one-of rule. Adding a check kind is adding a row here; no code edit. |
| `test/recipes.test.mjs` | Runs `recipeProblems` over every `records[].payload` in every `recipes/*.json` and expects none; also proves a check kind added only as a row in a copy of the vocabulary is accepted, and it refuses a step with no `do`, a repeated step id, a check that reads a later step, and a bad id with no job. |
| `recipes/grow-on-reddit-without-selling-first.json` | `workflow:grow-on-reddit-without-selling-first`: choose 5 subreddits by where Google ranks them for the person's keywords, record their rules, reach 10 karma, leave 15 useful comments over 3 days with no self-promotion, then draft a post. The AI drafts everything, the person approves the exact words and sends them, and the AI never posts by itself. |
| `recipes/run-a-slideshow-page-that-sells-a-small-digital-product.json` | `workflow:run-a-slideshow-page-that-sells-a-small-digital-product`: list what the person really made, read the biggest pages in the niche as metadata for their top 3 formats, fix one visual style, outline the product with every item marked own or to-make, write and render 1080x1350 carousels whose last slide is the product, get the person's approval of every carousel, schedule only approved ones (self-hosted Postiz or by hand), and every Monday read views, saves and sales, make part 2 of the winners and a video of the biggest. The person owns the accounts and the checkout. |
| `recipes/validate-and-launch-a-subscription-app.json` | `workflow:validate-and-launch-a-subscription-app`: stop unless apps already charge for the problem and creators already post about it, record the top 3 competitors' onboarding beats, paywall and channels, write an onboarding in the same order of beats with original words, end it with a paywall that states price, trial, renewal and cancellation, write a plain store page, plan five growth channels with disclosures, and review installs, trials, paid users and revenue every Monday. The person approves and submits from their own developer account. |

## Recipe shape

A recipe file is `{ about, records: [{ id, address, payload }] }`. The payload is a `workflow-recipe` row: `kind`, `id` (`workflow:` then lowercase words and dashes), `label`, `job`, `source` (where the playbook came from and which of its parts were not adopted, and why), `input_schema` (a JSON Schema with `"type": "object"`), and `steps`. Each step has `id`, `title`, `do` (what to do, naming the exact tool, address or screen and the exact input), `submit` (a JSON Schema for what the step hands back) and `checks` (rules that must hold before the step counts as done; the kinds are the rows of `recipe-check-kinds.json`).

A recipe names no person, product, keyword or subreddit of its own: those are inputs.

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `recipeProblems` | `(row, vocabulary = CHECK_VOCABULARY) -> [string]` | Every plain-words problem with a recipe row; an empty list means the recipe is valid. A row with `definition` (engine steps and edges) is checked as a definition; otherwise its `steps` are checked one by one. |
| Step | `{ id, title, do, submit, run_tool?, checks?, actor_policy? }` | `id` is lowercase letters, numbers, dashes or underscores and unique; `do` is required; `submit` is a JSON Schema with `"type": "object"`. |
| Check | `{ kind, says, path, of?, in?, values?, words?, count?, catalog? }` | `kind` is a row of `recipe-check-kinds.json`, and the row names the other fields; paths start at `this`, `input` or `steps` and may read only earlier steps. |

## Dependencies

**Depends on:** `recipe-check-kinds.json` (read once when the validator loads) and the Node standard library. Kept as code: the five field shapes a row may name (`path`, `list`, `words`, `count`, `catalog`), because a new shape is a new test on a JSON value; the recipe and definition structure (`PIN`, step id patterns, actor-policy keys, `ask` and `check` step kinds), which is the engine's own closed format, not something a person extends; the recipes' steps name the tools the steps name (`tool:read-a-page-in-my-browser`, `tool:tell-the-person`), which the host offers.

**Depended on by:** nothing yet; the workflow engine will read `recipes/` once it moves here.
