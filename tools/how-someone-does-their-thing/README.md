# tools/how-someone-does-their-thing/

Keeps a profile of how a person or creator does their thing, such as their style or their voice, and checks that drafts made for them carry it. Ported from bitfield-packages `how-someone-does-their-thing`, which was records only: a profile record type, an instruction for deriving it from the subject's records, and a gate spec that asks a draft for two references to the profile. Here the rules are code; every subject, ref, field and item is the caller's input, and no profile ships with the tool.

The tool asks no model. `tool:brief-a-profile` gives the AI that called it the subject's own records and the rules for deriving the profile; the AI answers; `tool:keep-a-profile` checks the answer and gives back the profile record; `tool:check-a-draft-against-a-profile` checks that a draft carries the profile's references. The same profile record both shapes the drafts and is what they are checked against.

The store is not reached from here. A person's voice (their profiles, the edits they make to drafts, the words they posted) is kept in their own store by the recipe `workflow:keep-how-someone-does-their-thing` (`tools/workflows/recipes/keep-how-someone-does-their-thing.json`, kit `tools/workflows/kits/keep-how-someone-does-their-thing.json`). The rows below only shape what that recipe writes and reads (rule a-tool-is-only-what-the-store-cannot-do).

## Tools

| Tool | What it does |
|------|--------------|
| `tool:brief-a-profile` | The subject's records, the rules for the answer and its shape. Writes nothing. Refuses a subject with no records. |
| `tool:keep-a-profile` | Checks the derived items and refs and gives back one `profile` record under the profile's name: subject, feature schema, evaluator and generator refs, validation policy ref (one string, or the `gate_target_ref` and `gate_spec_ref` pair) and the derived items. Writes nothing; the store keeps the record, and keeping it again replaces it. Refuses empty items, items without a `kind`, a `value` and an `evidence` string (the shape the brief asked for), and refs that are not strings. |
| `tool:check-a-draft-against-a-profile` | Whether some block of the draft holds each required reference field, and, when the profile's name is given, names that profile. Judges references, not words. |
| `tool:save-voice` | Shapes what an AI learned into the `voice-profile` of one kind, from the profile the store holds for that kind (`earlier`). Only the fields `read-data/voice.json` names; `expected_set_at` refuses a save over a profile saved since it was read; an account keeps at most `max_profiles`. Gives back the `keep` row the store writes. `builds_on` names the profiles it sits on, earliest first. |
| `tool:keep-a-voice-edit` | Shapes the person's own change to words an AI wrote into a `voice-edit` row; no row when the words did not change. The store keeps only the newest `keep_edits`. |
| `tool:find-repeated-voice-edits` | Counts the word changes (removed, added, replaced) over the `edits` handed in (the person's voice-edit values, read by their AI from their store), once per draft, and shows those in at least `min_distinct_drafts` different drafts as proposals for the profile. Reads and keeps nothing. |

## Retired

| Tool | Where its work is now |
|------|----------------------|
| `tool:read-voice` | The recipe's `read` step: the store's profiles, newest edits and posted words, read directly. |
| `tool:forget-voice` | The recipe's `keep` step (c): the store deletes a profile, one edit, or every edit of a kind. |

## Files

| File | Purpose |
|------|---------|
| `read-data/profile.mjs` | The rules: brief, keep, check. Header lists the invariants. |
| `read-data/voice.mjs` | The person's writing voice, moved from Trillion-X/trillion `src/voice.mjs` (`ports/voice.json` names the source): the shapers for a profile, an edit and repeated edits. No record is read or kept here. Header lists the invariants. |
| `read-data/voice.json` | DATA: the record types, sizes, profile fields, where sent words come from, and the words an AI is told. |
| `ports/voice.json` | The port contract of the move: source repository, commit, paths and their BLAKE3 identities. |
| `do-work/brief-a-profile.mjs`, `do-work/keep-a-profile.mjs`, `do-work/check-a-draft-against-a-profile.mjs`, `do-work/save-voice.mjs`, `do-work/keep-a-voice-edit.mjs`, `do-work/find-repeated-voice-edits.mjs` | One command per row. |
| `part.json` | The rules file is public. |
| `what-this-tool-does-and-how-to-run-it.json` | The six rows, each with a sample run. |
| `test/how-someone-does-their-thing.test.mjs` | Tests with made-up subjects, refs and drafts. |
| `test/voice.test.mjs` | The voice shapers and their rows, with made-up words. |

## Not carried

The old build workflow (gather records, dispatch an AI producer, write facts back), its entity-type and attribute records, and its conformance test of that wiring belonged to the old engine. The profile's `last_build_result_ref`, which pointed at the result of that workflow's last run, is not carried: it was the workflow's own bookkeeping, and a profile kept here is replaced by keeping it again. The names of the two reference fields the old gate asked for are now `required_ref_fields`, the caller's.

## Dependencies

**Depends on:** Node 24. No records door: the store is the recipe's (`tools/workflows`).

**Depended on by:** `what-this-tool-does-and-how-to-run-it.json`.

## Restored from bitfield-packages `how-someone-does-their-thing`

The package was records only; its boundary file is kept as written under `from-bitfield-packages-how-someone-does-their-thing/things-to-store-and-run.json`: the `profile` entity type with its six properties, the build-profile instruction (the wrapper words an AI is given with the subject's records), the profile-fit gate spec, and the build-profile workflow action (gather the subject's records, ask the records producer, write the items back as profile facts). The rows above carry the profile and voice rules in this tree; the build workflow itself needs the workflow-recipe form and is held. The package's conformance test of that workflow's wiring is kept as a held test.

| File | Purpose |
|------|---------|
| `__tests__/profile-chain.conformance.test.ts.held` | Held test: reads the things-to-store-and-run.json of two sibling packages (how-someone-does-their-thing and profile-a-cre |
| `from-bitfield-packages-how-someone-does-their-thing/README.md` | The package's own note, moved as written. |
| `from-bitfield-packages-how-someone-does-their-thing/things-to-store-and-run.json` | Data the package carried as written. |
| `from-bitfield-packages-how-someone-does-their-thing/moved-from.json` | Source path and commit of each file, identities, call rows, held tests, files that still call the retired runtime. |
