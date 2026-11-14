# how-someone-does-their-thing

## Job

This package defines a data-only profile record for how a subject does their thing: a creator style, a user's voice, or any other reference pattern. The same profile address is used both as validation input and as draft-conditioning input.

## Reuse

AI record production is delegated by Envelope workflow dispatch to `package::ai-records-producer::workflow-action::run-ai-records-production`. Validation is delegated by data reference to `package::content-gate::target::evaluate`. This package does not own provider selection, model choice, prompt execution, logging, memory, scheduling, publishing, transcription, or credential handling.

## Data

`things-to-store-and-run.json` admits the profile EEAF facts, registration records, a profile-build workflow action, a content-gate policy spec, and a profile-build input descriptor. The build workflow gathers subject facts with `slot::find-current-items`, dispatches `action:run-ai-records-production`, and writes the returned items back onto the profile as profile facts.

## Boundary

There is no source handler in this package. Behavior lives in admitted records, and package-to-package wiring appears only as data addresses. Changing what a profile means should change records in `things-to-store-and-run.json`, not TypeScript or Rust source.
