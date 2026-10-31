# tools/triage-against-priorities/

Decides what to do with one incoming item (a message, a note, a finding, the result of a run) by weighing it against what the person cares most about, and keeps the decision only if it holds up. Ported from bitfield-packages `commander-triage`, which was records only: a rubric, a catalog of dispositions, a floor on confidence and a fail-closed decision. Here the rubric and the five checks are code; every priority, disposition and number is the person's input.

The tool asks no model. `tool:brief-a-triage` gives the AI that called it everything it needs to judge the item; the AI answers; `tool:settle-a-triage` keeps the answer if it holds and otherwise settles the item on the person's fallback disposition, blocked, saying why in words. A decision does nothing by itself: `blocked` says whether the disposition's owner may act on it yet, and it is true unless the disposition's row says `blocked_default: false`.

## Files

| File | Purpose |
|------|---------|
| `read-data/triage.mjs` | The pure rules: check the rows, build the brief, settle an answer. Header lists the four invariants. |
| `do-work/brief-a-triage.mjs` | `tool:brief-a-triage`: the item, priorities, dispositions, rules and answer shape. Writes nothing. |
| `do-work/settle-a-triage.mjs` | `tool:settle-a-triage`: the decision record (kept as `triage-decision:<ref>:<version>`). |
| `part.json` | The rules file is public. |
| `tool-rows.json` | The Workshop rows for both tools, each with a sample run. |
| `test/triage-against-priorities.test.mjs` | Tests with made-up items, priorities and dispositions. |

## Input the person gives

| Input | Meaning |
|-------|---------|
| `priorities` | Records of what they care about most. None means every item fails closed. |
| `dispositions` | Rows `{ref, label, note?, fallback?, blocked_default?, needs_objective?}`. Exactly one is the fallback. |
| `min_confidence` | The least confidence an answer may have, from 0 to 1. No default. An answer with a confidence over 1 or under 0, or one that is not a number, fails closed. |
| `max_words` | Optional `{rationale?, objective?}`: the most words each may have, a whole number of 1 or more. Told in the brief and enforced when settling. No default; unnamed means no limit. |

## What the brief always says

The wording that holds for everyone is in the code and always in the brief: judge against the priorities, answer with one object, fail closed. For a disposition that needs an objective, the objective is the smallest safe, reversible assignment that produces evidence, and it must not authorize sending messages, spending, publishing, promises to others, credential changes, changes to a live system, anything illegal, deceiving or harassing anyone, or taking what belongs to another party. The old rubric's numbers (the confidence floor and the word limits) are not in the code; they are `min_confidence` and `max_words`.

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `checkRows` | `({item, priorities, dispositions, min_confidence, max_words?}) -> {fallback}` | Refuses a request that cannot be briefed or settled: an item with no ref, priorities that are not a list, a confidence outside 0 to 1, no or repeated dispositions, not exactly one fallback, a bad `max_words`. |
| `briefFor` | `(request) -> {item, priorities, dispositions, min_confidence, max_words?, rules, answer_shape, priorities_given}` | What the caller's AI judges from. Asks no model. |
| `settleTriage` | `(request + {answers}) -> decision` | The decision record `{type: "triage-decision", id, item, priorities_seen, disposition_ref, confidence, blocked, fail_closed, reasons, rationale?, objective?, acceptance_criteria?, target_ref?}`. The answer when it holds, else the fallback, blocked, `confidence: 0`, with each reason in words. |
| Decision id | `triage-decision:<item.ref>:<item.version>` (each part URI-encoded) | One id for an item at a version, so settling again makes the same record. |

## Not carried

The old package's record queries, its trigger rules that fired on every admitted item, the process-session launch of authorized work, the guarded effect descriptors and the bounded brief screen belonged to the old engine. The brief screen is drawn from the kept decisions by the screens owner.

## Dependencies

**Depends on:** Node 24 only.

**Depended on by:** `tool-rows.json`.
