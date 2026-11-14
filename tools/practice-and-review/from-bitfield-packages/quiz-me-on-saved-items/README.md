# Quiz Me On Saved Items

## Purpose

`quiz-me-on-saved-items` is a connector package for the founder growth engine. It turns a summarized `captured-item` record from `package::founder-growth-engine-screens::captured-item::<id>` into an active-recall `question-sequence`, then routes recall answers into the existing learning substrate.

## Data Records

All behavior lives in `things-to-store-and-run.json` under the top-level `things` key. The package defines the `instr:make-recall-questions` `ai-records-producer.instruction`, one workflow-action that writes a `question-sequence`, and trigger EEAF records using the `attribute_fact|subject|property|type:<type>` grammar with entity/type registrations.

## Reused Addresses

This package reuses `package::ai-records-producer::workflow-action::run-ai-records-production` (`action:run-ai-records-production`) for generation, `package::ask-questions-sort-answers-follow-up::input::published-records` for question-sequence consumption, `package::spaced-repetition::workflow-action::request-review-response` (`action:spaced-repetition.request-review-response`) for review responses, and `package::learning-progress::workflow-action::request-progress-event` (`action:learning-progress.request-progress-event`) for progress events.

## Boundaries

This package owns no AI provider selection, model choice, prompt execution, question UI, answer capture, review scheduling, or progress rollup logic. Cross-package coordination is data-only through Envelope addresses and `slot::workflow` dispatch.
