# workflows

Shared playbooks that any person's AI can follow step by step. Each playbook is one recipe file in `recipes/`; the workflow engine that runs them is arriving here from `crates/workflow-engine` in the main Trillion repository.

## Files

| File | Purpose |
|------|---------|
| `read-data/recipe-problems.mjs` | The recipe validator: `recipeProblems(row)` names every problem with a `workflow-recipe` row at once (id, job, input schema, steps, tool calls and pins, checks, actor policy, or a written `definition`). A recipe with no problems can be run by any account. |
| `test/recipes.test.mjs` | Runs `recipeProblems` over every `records[].payload` in every `recipes/*.json` and expects none; also proves it refuses a step with no `do`, a repeated step id, a check that reads a later step, and a bad id with no job. |
| `recipes/grow-on-reddit-without-selling-first.json` | `workflow:grow-on-reddit-without-selling-first`: choose 5 subreddits by where Google ranks them for the person's keywords, record their rules, reach 10 karma, leave 15 useful comments over 3 days with no self-promotion, then draft a post. The AI drafts everything, the person approves the exact words and sends them, and the AI never posts by itself. |
| `recipes/run-a-slideshow-page-that-sells-a-small-digital-product.json` | `workflow:run-a-slideshow-page-that-sells-a-small-digital-product`: list what the person really made, read the biggest pages in the niche as metadata for their top 3 formats, fix one visual style, outline the product with every item marked own or to-make, write and render 1080x1350 carousels whose last slide is the product, get the person's approval of every carousel, schedule only approved ones (self-hosted Postiz or by hand), and every Monday read views, saves and sales, make part 2 of the winners and a video of the biggest. The person owns the accounts and the checkout. |
| `recipes/validate-and-launch-a-subscription-app.json` | `workflow:validate-and-launch-a-subscription-app`: stop unless apps already charge for the problem and creators already post about it, record the top 3 competitors' onboarding beats, paywall and channels, write an onboarding in the same order of beats with original words, end it with a paywall that states price, trial, renewal and cancellation, write a plain store page, plan five growth channels with disclosures, and review installs, trials, paid users and revenue every Monday. The person approves and submits from their own developer account. |

## Recipe shape

A recipe file is `{ about, records: [{ id, address, payload }] }`. The payload is a `workflow-recipe` row: `kind`, `id` (`workflow:` then lowercase words and dashes), `label`, `job`, `source` (where the playbook came from and which of its parts were not adopted, and why), `input_schema` (a JSON Schema with `"type": "object"`), and `steps`. Each step has `id`, `title`, `do` (what to do, naming the exact tool, address or screen and the exact input), `submit` (a JSON Schema for what the step hands back) and `checks` (rules that must hold before the step counts as done: `subset-of`, `covers`, `mentioned-in`, `excludes-words`, `distinct-at-least`, `exists`).

A recipe names no person, product, keyword or subreddit of its own: those are inputs.

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `recipeProblems` | `(row) -> [string]` | Every plain-words problem with a recipe row; an empty list means the recipe is valid. A row with `definition` (engine steps and edges) is checked as a definition; otherwise its `steps` are checked one by one. |
| Step | `{ id, title, do, submit, run_tool?, checks?, actor_policy? }` | `id` is lowercase letters, numbers, dashes or underscores and unique; `do` is required; `submit` is a JSON Schema with `"type": "object"`. |
| Check | `{ kind, says, path, of?, in?, values?, words?, count?, catalog? }` | `kind` is one of `subset-of`, `covers`, `mentioned-in`, `excludes-words`, `distinct-at-least`, `exists`; paths start at `this`, `input` or `steps` and may read only earlier steps. |

## Dependencies

**Depends on:** nothing for the validator (Node standard library only); the recipes' steps name the tools the steps name (`tool:read-a-page-in-my-browser`, `tool:tell-the-person`), which the host offers.

**Depended on by:** nothing yet; the workflow engine will read `recipes/` once it moves here.
