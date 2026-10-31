# tools/how-someone-does-their-thing/

Keeps a profile of how a person or creator does their thing, such as their style or their voice, and checks that drafts made for them carry it. Ported from bitfield-packages `how-someone-does-their-thing`, which was records only: a profile record type, an instruction for deriving it from the subject's records, and a gate spec that asks a draft for two references to the profile. Here the rules are code; every subject, ref, field and item is the caller's input, and no profile ships with the tool.

The tool asks no model. `tool:brief-a-profile` gives the AI that called it the subject's own records and the rules for deriving the profile; the AI answers; `tool:keep-a-profile` keeps the profile record if the answer holds up; `tool:check-a-draft-against-a-profile` checks that a draft carries the profile's references. The same profile record both shapes the drafts and is what they are checked against.

## Tools

| Tool | What it does |
|------|--------------|
| `tool:brief-a-profile` | The subject's records, the rules for the answer and its shape. Writes nothing. Refuses a subject with no records. |
| `tool:keep-a-profile` | One `profile` record under the profile's name: subject, feature schema, evaluator and generator refs, validation policy ref (one string, or the `gate_target_ref` and `gate_spec_ref` pair) and the derived items. Keeping it again replaces it. Refuses empty items, items without a `kind`, a `value` and an `evidence` string (the shape the brief asked for), and refs that are not strings. |
| `tool:check-a-draft-against-a-profile` | Whether some block of the draft holds each required reference field, and, when the profile's name is given, names that profile. Judges references, not words. |

## Files

| File | Purpose |
|------|---------|
| `read-data/profile.mjs` | The rules: brief, keep, check. Header lists the invariants. |
| `do-work/brief-a-profile.mjs`, `do-work/keep-a-profile.mjs`, `do-work/check-a-draft-against-a-profile.mjs` | One command per row. |
| `part.json` | The rules file is public. |
| `tool-rows.json` | The three rows, each with a sample run. |
| `test/how-someone-does-their-thing.test.mjs` | Tests with made-up subjects, refs and drafts. |

## Not carried

The old build workflow (gather records, dispatch an AI producer, write facts back), its entity-type and attribute records, and its conformance test of that wiring belonged to the old engine. The profile's `last_build_result_ref`, which pointed at the result of that workflow's last run, is not carried: it was the workflow's own bookkeeping, and a profile kept here is replaced by keeping it again. The names of the two reference fields the old gate asked for are now `required_ref_fields`, the caller's.

## Dependencies

**Depends on:** Node 24 only.

**Depended on by:** `tool-rows.json`.
