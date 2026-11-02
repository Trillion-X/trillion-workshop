# tools/how-someone-does-their-thing/

Keeps a profile of how a person or creator does their thing, such as their style or their voice, and checks that drafts made for them carry it. Ported from bitfield-packages `how-someone-does-their-thing`, which was records only: a profile record type, an instruction for deriving it from the subject's records, and a gate spec that asks a draft for two references to the profile. Here the rules are code; every subject, ref, field and item is the caller's input, and no profile ships with the tool.

The tool asks no model. `tool:brief-a-profile` gives the AI that called it the subject's own records and the rules for deriving the profile; the AI answers; `tool:keep-a-profile` keeps the profile record if the answer holds up; `tool:check-a-draft-against-a-profile` checks that a draft carries the profile's references. The same profile record both shapes the drafts and is what they are checked against.

## Tools

| Tool | What it does |
|------|--------------|
| `tool:brief-a-profile` | The subject's records, the rules for the answer and its shape. Writes nothing. Refuses a subject with no records. |
| `tool:keep-a-profile` | One `profile` record under the profile's name: subject, feature schema, evaluator and generator refs, validation policy ref (one string, or the `gate_target_ref` and `gate_spec_ref` pair) and the derived items. Keeping it again replaces it. Refuses empty items, items without a `kind`, a `value` and an `evidence` string (the shape the brief asked for), and refs that are not strings. |
| `tool:check-a-draft-against-a-profile` | Whether some block of the draft holds each required reference field, and, when the profile's name is given, names that profile. Judges references, not words. |
| `tool:read-voice` | How the person writes, read before drafting for them: their `voice-profile` records (one per kind of writing), their newest `voice-edit` records (an AI's words before, theirs after) and the words of their posted `post` records. Writes nothing. |
| `tool:save-voice` | Keeps what an AI learned as the `voice-profile` of one kind. Only the fields `read-data/voice.json` names; `expected_set_at` refuses a save over a profile saved since it was read. `builds_on` names the profiles it sits on, earliest first (a base, a market, a team), so layers are profiles, not a second store. |
| `tool:forget-voice` | Removes one profile, one edit, or every edit (of one kind), and says how many. |
| `tool:keep-a-voice-edit` | Keeps the person's own change to words an AI wrote as a `voice-edit`; nothing when the words did not change. Only the newest `keep_edits` are kept. |
| `tool:find-repeated-voice-edits` | Counts the word changes (removed, added, replaced) over the kept edits, once per draft, and shows those in at least `min_distinct_drafts` different drafts as proposals for the profile. Keeps nothing. |

## Files

| File | Purpose |
|------|---------|
| `read-data/profile.mjs` | The rules: brief, keep, check. Header lists the invariants. |
| `read-data/voice.mjs` | The person's writing voice, moved from Trillion-X/trillion `src/voice.mjs` (`ports/voice.json` names the source): read, save, forget, keep an edit, count repeated edits, over the records door. Header lists the invariants. |
| `read-data/voice.json` | DATA: the record types, sizes, profile fields, where sent words come from, and the words an AI is told. |
| `ports/voice.json` | The port contract of the move: source repository, commit, paths and their BLAKE3 identities. |
| `do-work/brief-a-profile.mjs`, `do-work/keep-a-profile.mjs`, `do-work/check-a-draft-against-a-profile.mjs` | One command per row. |
| `part.json` | The rules file is public. |
| `tool-rows.json` | The eight rows, each with a sample run. |
| `test/how-someone-does-their-thing.test.mjs` | Tests with made-up subjects, refs and drafts. |
| `test/voice.test.mjs` | The moved voice tests, each row run against the stand-in records door with made-up words. |

## Not carried

The old build workflow (gather records, dispatch an AI producer, write facts back), its entity-type and attribute records, and its conformance test of that wiring belonged to the old engine. The profile's `last_build_result_ref`, which pointed at the result of that workflow's last run, is not carried: it was the workflow's own bookkeeping, and a profile kept here is replaced by keeping it again. The names of the two reference fields the old gate asked for are now `required_ref_fields`, the caller's.

## Dependencies

**Depends on:** Node 24; the voice rows pack `tools/records-door` and `tools/content-identity`.

**Depended on by:** `tool-rows.json`.
