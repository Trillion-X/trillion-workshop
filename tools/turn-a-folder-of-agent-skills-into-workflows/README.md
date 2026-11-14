# tools/turn-a-folder-of-agent-skills-into-workflows/

Turn a person's own agent skills into workflows in their own account, where their AI finds, reads and runs them.

- `tool:turn-my-agent-skills-into-workflows` (`tool-rows.json`) reads the rows of the person's agent-skills list (`record:agent-skill`, one row per file, a long file in parts), and writes one workflow per clean skill: a `record:workflow-recipe` row and one `record:workflow-step` row whose `do` is the skill's instructions, with its text files under `files`. Only into the person's own account, never the public Workshop.
- A skill stays home when its `SKILL.md` or any file that would ship holds a secret key, a folder on a computer, an email address, a phone number, or a word the person lists in `private_words`. The answer names the skill and the kind of reason, never the text. What is screened, the size budget and the file types are data: `data/skill-import-rules.json`.
- A re-run writes the same ids, so it updates. A workflow whose skill is gone is named under `stale` and left alone. `dry_run` writes nothing.
- Code: `read-data/skills-into-workflows.mjs`. Tests: `test/` (pure steps, and the row run the way the engine runs it on the stand-in records door). Kit: `kits/turn-my-agent-skills-into-workflows.json`.

Ported from old Trillion's `scripts/skills-to-workflows.mjs`, `src/skill-rows.mjs` and `records/skill-import-rules.json` (commit 99651cea06). One change from the original, because the destination changed: the old rule "a skill ships only when its maker may share it" guarded a public shelf; these rows stay in the person's own account, so a skill's licence rides on the row's `source` and is not a gate. The secret, path, address, phone and private-word screens are the original's.

`from-old-trillion/` holds the original script's bytes (tag `old-trillion-before-worker-retire`), kept as the receipt `moved-from.json` names; it is not run.
