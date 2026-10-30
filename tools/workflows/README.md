# workflows

Shared playbooks that any person's AI can follow step by step. Each playbook is one recipe file in `recipes/`; the workflow engine that runs them is arriving here from `crates/workflow-engine` in the main Trillion repository.

## Files

| File | Purpose |
|------|---------|
| `recipes/grow-on-reddit-without-selling-first.json` | `workflow:grow-on-reddit-without-selling-first`: choose 5 subreddits by where Google ranks them for the person's keywords, record their rules, reach 10 karma, leave 15 useful comments over 3 days with no self-promotion, then draft a post. The AI drafts everything, the person approves the exact words and sends them, and the AI never posts by itself. |

## Recipe shape

A recipe file is `{ about, records: [{ id, address, payload }] }`. The payload is a `workflow-recipe` row: `kind`, `id` (`workflow:` then lowercase words and dashes), `label`, `job`, `source` (where the playbook came from and which of its parts were not adopted, and why), `input_schema` (a JSON Schema with `"type": "object"`), and `steps`. Each step has `id`, `title`, `do` (what to do, naming the exact tool, address or screen and the exact input), `submit` (a JSON Schema for what the step hands back) and `checks` (rules that must hold before the step counts as done: `subset-of`, `covers`, `mentioned-in`, `excludes-words`, `distinct-at-least`, `exists`).

A recipe names no person, product, keyword or subreddit of its own: those are inputs.

## Dependencies

**Depends on:** the tools the steps name (`tool:read-a-page-in-my-browser`, `tool:tell-the-person`), which the host offers.

**Depended on by:** nothing yet; the workflow engine will read `recipes/` once it moves here.
