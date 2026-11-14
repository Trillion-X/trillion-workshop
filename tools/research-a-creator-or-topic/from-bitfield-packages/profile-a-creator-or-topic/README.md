# Profile A Creator Or Topic

## Purpose

`profile-a-creator-or-topic` is a data-only connector for the founder growth engine. Given a captured-item URL record or typed creator/topic subject ref, it creates a profile envelope and delegates profile extraction to the existing generic profile and AI-record production substrate.

## Data Records

- `package::profile-a-creator-or-topic::instruction::research-creator` registers `instr:research-creator` as an `ai-records-producer.instruction`.
- `package::profile-a-creator-or-topic::workflow-action::profile-creator-or-topic` writes profile EEAF facts and dispatches the existing profile builder.
- `package::profile-a-creator-or-topic::input::creator-profile-builds` describes a cell-table input for `profile_ref`, `subject_ref`, `request_id`, and optional `instruction_text`.

## Reused Addresses

- `package::how-someone-does-their-thing::workflow-action::build-profile`
- `package::ai-records-producer::workflow-action::run-ai-records-production`
- `package::content-gate::target::evaluate`
- `package::how-someone-does-their-thing::content-gate-spec::profile-fit`

## Boundary

This package does not own AI invocation, provider/model selection, prompt execution, validation logic, scheduling, question asking, or captured-item storage. Those behaviors remain data-owned by their existing packages; this package only adds connector DATA in `things-to-store-and-run.json`.
