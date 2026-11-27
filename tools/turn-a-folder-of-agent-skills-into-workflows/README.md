# tools/turn-a-folder-of-agent-skills-into-workflows/

Turn a person's own agent skills into workflows their AI can find, read and run. The tool keeps nothing: the skills come in the request and the workflows come back in the answer.

- `tool:turn-my-agent-skills-into-workflows` (`what-this-tool-does-and-how-to-run-it.json`) takes the rows of the person's agent-skills list in `records` (`record:agent-skill`, one row per file, a long file in parts), and answers one workflow per clean skill under `workflows`: a `record:workflow-recipe` row and one `record:workflow-step` row whose `do` is the skill's instructions, with its text files under `files`. It has no records door and writes nothing; the caller's AI writes the rows where the person keeps workflows.
- A skill stays home when its `SKILL.md` or any file that would ship holds a secret key, a folder on a computer, an email address, a phone number, or a word the person lists in `private_words`. The answer names the skill and the kind of reason, never the text. What is screened, the size budget and the file types are data: `data/skill-import-rules.json`.
- A re-run answers the same ids. Hand it the `record:workflow-recipe` rows already kept in `records` and a workflow whose skill is gone is named under `stale`.
- Code: `read-data/skills-into-workflows.mjs`. Tests: `test/` (pure steps, and the row run the way the engine runs it, with no records door). Kit: `kits/turn-my-agent-skills-into-workflows.json`.

Ported from old Trillion's `scripts/skills-to-workflows.mjs`, `src/skill-rows.mjs` and `records/skill-import-rules.json` (commit 99651cea06). One change from the original, because the destination changed: the old rule "a skill ships only when its maker may share it" guarded a public shelf; these rows stay in the person's own account, so a skill's licence rides on the row's `source` and is not a gate. The secret, path, address, phone and private-word screens are the original's.

The original script's bytes are at tag `old-trillion-before-worker-retire` (b6ae0ebf81), named by the receipt `moved-from.json`; no copy is kept in this folder. Its unit tests: 9 pass (`test/skills-into-workflows.test.mjs`).
