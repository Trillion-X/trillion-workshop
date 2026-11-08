# tools/generate-content-drafts/

Compile source material and a format into a presentation plan, check that plan against fresh observations, and select a content style from DATA. The three engines were copied unchanged from the declared original owner in commit `9427b9a0`, before adapting their command boundaries. The original source addresses and byte identities are recorded privately by the port contracts' path identities.

| Entry | Result |
|---|---|
| `tool:compile-a-presentation-plan` | The plan, rendered beats, unchanged claim snapshot, required capabilities and evidence requirements. Missing fields and claims are reported together. New plan identities use the shared BLAKE3 owner. |
| `tool:check-a-presentation-plans-readiness` | Missing capabilities, wrong evidence methods and stale observations, or `ready_to_authorize`. Only a satisfied requirement actually observed by a sensor can mark physical setup independently verified. |
| `tool:choose-a-content-style` | A manually selected definition or the first matching rule. An unmatched rule reports that local AI selection is required. The container row runs no caller-supplied command. |

Each row takes JSON on stdin and emits `{ result }`. Human and automation callers can use the same three commands with `--json`, or their original file/flag interfaces. The public modules export `compilePresentationPlan`, `evaluatePresentationReadiness` and `chooseContentStyle` without running a command on import. All computation leaves input objects unchanged and keeps no records.

The original classifier's authorized local CLI AI mode remains available through its file/flag interface (`--rules`, `--mode ai`, `--definitions`), with the local program and timeout supplied by the rules DATA. It now accepts exactly one supplied definition as the complete trimmed answer, so a partial identifier or an explanation containing several choices is refused. This path is separate from the deterministic container row and requires the caller's local execution authority.

Formats and classification rules remain editable DATA. Recompile after editing material or format revisions; that creates the next plan identity while preserving the earlier artifact. Save, read, replace or remove plan artifacts through the caller's authorized file/record owner. Readiness neither grants capture permission nor starts a device. Plans and observations are caller-supplied evidence; this tool does not authenticate a sensor or establish publication rights.

This bounded move carries these three source engines and their retained DATA/tests. The original package's screens, run submission, derived-text generation and audience-question workflow have not been qualified here. Original callers, installed row execution, publication and source retirement remain pending; this source commit does not establish a complete package migration.

Tests: `node --test tools/generate-content-drafts/test/*.test.mjs tools/generate-content-drafts/do-work/__tests__/*.test.mjs`.
