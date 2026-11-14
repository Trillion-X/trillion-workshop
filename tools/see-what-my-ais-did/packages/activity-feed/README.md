# Activity Feed

Package-owned recent activity projection capability.

## Files

| File | Purpose |
| --- | --- |
| `things-to-store-and-run.json` | Publishes the `Recent activity` + overlay surfaces, the scoped `activity-fact` feed, **and the PRODUCER** (`trigger-rule`s + the generic `workflow-action::emit-activity-fact`). |
| `read-data/` | Human-facing recent-activity display data. |
| `show/` | Browser material for the recent-activity pane + live overlay (`ActivityIndicator`). |

## Producer (why the feed is no longer empty)

The feed reads `activity-fact` records but nothing wrote them (generic-but-empty), so it was blank. Fixed as pure DATA (L136), zero engine:

- **`workflow-action::emit-activity-fact`** — a GENERIC handler: writes an `activity-fact` with `actor_id/actor_type/package_id/record_kind/action_type` **all bound from input** (a hardcoded `actor_type` would mislabel non-AI sources), `event_hash` from `envelope.content_hash`.
- **`trigger-rule`s (one per source)** — e.g. `emit-activity-fact-on-ai-result` (`ai-records-producer.result`, action_type `write`) and `emit-activity-fact-on-article` (`content-generation.article-result`, action_type `publish`). **Adding an activity source = one trigger-rule DATA row, zero code.**

## Rules

- The package can own activity-feed records, but visible product language is `Recent activity`.
- Production UI must not render fake activity rows.
- `actor_type`/`action_type` are per-source DATA (in the trigger dispatch), never hardcoded in the generic handler or renderer.
