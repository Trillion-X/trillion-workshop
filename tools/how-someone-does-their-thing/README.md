# tools/how-someone-does-their-thing/

Keeps a profile of how a person or creator does their thing, such as their style or their voice, and checks that drafts made for them carry it. Ported from bitfield-packages `how-someone-does-their-thing`, which was records only: a profile record type, an instruction for deriving it from the subject's records, and a gate spec that asks a draft for two references to the profile. Here the rules are code; every subject, ref, field and item is the caller's input, and no profile ships with the tool.

The tool asks no model. `tool:brief-a-profile` gives the AI that called it the subject's own records and the rules for deriving the profile; the AI answers; `tool:keep-a-profile` keeps the profile record if the answer holds up; `tool:check-a-draft-against-a-profile` checks that a draft carries the profile's references. The same profile record both shapes the drafts and is what they are checked against.

## Tools

| Tool | What it does |
|------|--------------|
| `tool:brief-a-profile` | The subject's records, the rules for the answer and its shape. Writes nothing. Refuses a subject with no records. |
| `tool:keep-a-profile` | One `profile` record under the profile's name: subject, feature schema, evaluator and generator refs, validation policy ref (one string, or the `gate_target_ref` and `gate_spec_ref` pair) and the derived items. Keeping it again replaces it. Refuses empty items, items without a `kind`, a `value` and an `evidence` string (the shape the brief asked for), and refs that are not strings. |
| `tool:check-a-draft-against-a-profile` | Whether some block of the draft holds each required reference field, and, when the profile's name is given, names that profile. Judges references, not words. |
| `tool:layer-a-writing-style` | Builds one writer's style from layers read in order: base, then niche, then group (a company or any team), then person (their own diction and syntax). A later layer overrides an earlier one field by field; lists add to the earlier ones unless the layer names the field in `replace`; `off` drops an entry an earlier layer added. Returns the merged `style`, `provenance` (which layers set each value), the `instruction_text` an AI writes from and `items` that `tool:keep-a-profile` takes, so the layered style becomes a profile drafts are checked against. The shipped base is added when no base is given. Layers out of order, an unknown level or field, or a layer with no id are refused. Asks no model, keeps nothing; the caller reads its niche, group and person rows from its own records and passes them in. |
| `tool:find-repeated-edits` | From pairs of a draft as written and as the person left it, finds the words removed, added or replaced and counts the different drafts each change recurs in. Only a change in at least `min_distinct_drafts` drafts (3 when left out, never below 2) is returned, as a candidate rule with its example; fewer drafts than that are refused. Candidates are proposals for the person to approve, for example into their person layer; nothing is kept. |

## Files

| File | Purpose |
|------|---------|
| `read-data/profile.mjs` | The rules: brief, keep, check. Header lists the invariants. |
| `read-data/layers.mjs` | `layerAWritingStyle`: the merge of layers. It names no level, field or writer; header lists the invariants. |
| `read-data/writing-layers.json` | DATA: the levels in order, the merge each field takes (list, range, text), the sentence each field adds to the instruction, and the one generic base layer (plain and specific; no invented customers, results, figures or quotations; evidence kept apart from inference). Adding a field is adding a row. Niche, group and person layers are never shipped: they are the caller's records. |
| `read-data/edits.mjs` | `findRepeatedEdits`: word-level changes between a draft and its edit, counted by different drafts. |
| `do-work/brief-a-profile.mjs`, `do-work/keep-a-profile.mjs`, `do-work/check-a-draft-against-a-profile.mjs`, `do-work/layer-a-writing-style.mjs`, `do-work/find-repeated-edits.mjs` | One command per row. |
| `part.json` | The rules file is public. |
| `tool-rows.json` | The five rows, each with a sample run. |
| `test/how-someone-does-their-thing.test.mjs` | Tests with made-up subjects, refs and drafts. |
| `test/layered-style-and-edits.test.mjs` | Layer order, overrides, provenance, `replace`, `off`, refusals, a field added only as a data row; repeated edits counted by different drafts, the minimum as the caller's knob. |

## Not carried

The old build workflow (gather records, dispatch an AI producer, write facts back), its entity-type and attribute records, and its conformance test of that wiring belonged to the old engine. The profile's `last_build_result_ref`, which pointed at the result of that workflow's last run, is not carried: it was the workflow's own bookkeeping, and a profile kept here is replaced by keeping it again. The names of the two reference fields the old gate asked for are now `required_ref_fields`, the caller's.

## Dependencies

**Depends on:** Node 24 only.

**Depended on by:** `tool-rows.json`.
