# tools/set-up-my-account/

Draws a person's Get started screen: which setup steps apply to their account, which are done, which only they can do, whether their workspace is ready, and how to connect their AI. Until 2026-11-03 the trillion-rust engine drew it (`/screens/get-started`, `src/workspace_setup` and `src/local_workspace/setup.rs`); the engine knows no product, so the screen moved here and the page asks this tool through the door (`POST /work/api/door/tools:run`).

- **The decisions moved here as they were.** `read-data/setup-steps.mjs` (`setupSteps`, `setupStepsWithRules`), `read-data/get-started-screen.mjs` (`getStartedFacts`, from `src/account-screens.mjs`) and their imports are byte copies of trillion `d273ef3`, changed only in their import paths (see `ports/`). The setup DATA (`setup-steps.json`, `setup-policy.json`, `setup-access.json`, `ai-clients.json`, `ai-setup-prompt.json`, `computer-sources.json`, `harnesses.json`) is the copy the engine read from its `product/` folder, which it no longer has.
- **Fails closed.** A fact the request leaves out is unknown, never done. A rule set or setup context the request leaves out (`shared_rules`, `rules`, `context`, `personal_context`) is unknown too, so the screen is not ready (`policy.requirements_resolved: false`) rather than opening on a guess.
- **The show rules are decided by the Workshop's one rule evaluator.** `setupStepsWithRules` asks `filterRows` for each rule's condition; here that is `filterRowsByRules`, the formula engine's row filter (trillion `parts/formula-engine/rules/filter-rows-by-rules.mjs`) over `tools/formulas` (its compiler, evaluator and comparison rows, which now include `is_true` and `is_false`).
- **Nothing is read or kept.** Every fact comes in the request.

## Files

| File | Purpose |
|------|---------|
| `do-work/read-setup.mjs` | `readSetup`, `tool:read-setup`: the Get started screen's one read (tool:get-started). It asks the account files door's `setup_facts` for the asking browser's user_agent and origin, reads the account's own `show-rules` and `setup-context` records, and runs `tool:see-what-is-left-to-set-up` with them and the page's account id (the row declares it in `runs`), as old trillion's readSetup over GET /setup/facts did. A source it cannot read is left unknown. |
| `do-work/see-what-is-left-to-set-up.mjs` | `seeWhatIsLeftToSetUp(request)` and `filterRowsByRules`; the row's command (request on standard input, `{ result }` or `{ error }` on the last line) |
| `read-data/setup-steps.mjs` | Which steps apply (show rules), their facts, done or not, workspace readiness and the policy answer |
| `read-data/get-started-screen.mjs` | `getStartedFacts`: the screen (title, lead, sections, steps with their owner) from the steps |
| `read-data/setup-checks.mjs`, `harnesses.mjs`, `show-rules.mjs`, `sidebar-rules.mjs`, `rule-decisions.mjs`, `conflicts.mjs`, `failure.mjs`, `personal-hold.mjs`, `site-icon-url.mjs`, `ai-app-guides.mjs`, `ask-your-ai.mjs` | The modules those two import, moved with them |
| `read-data/*.json` | The setup DATA, the show rules (`show-rules.json`) and the failure words |
| `ports/` | One port contract per moved file, and the entry's `NO_PRIOR_OWNER` claim |
| `tool-rows.json` | `tool:see-what-is-left-to-set-up` |
| `test/` | The trillion tests of the moved code (`setup-steps`, `setup-checks` without its profile-name tests, `setup-screen-plain`, with `setup-fixtures.mjs`), and the row's own test |

## The row

| Row | Function | What it does |
|-----|----------|--------------|
| `tool:read-setup` | `readSetup` | `{ account_id, user_agent?, origin?, now? }` → the Get started screen, gathered from the files door and the account's own records, drawn by `tool:see-what-is-left-to-set-up` |
| `tool:see-what-is-left-to-set-up` | `seeWhatIsLeftToSetUp` | `{ account_id, facts, system?, shared_rules?, rules?, context?, personal_context?, setup_access?, installs?, origin?, now? }` → the Get started screen (`title`, `lead`, `ready`, `setup_complete`, `workspace_mode`, `requirements`, `policy`, `sections`) |

## Not moved yet

- **Who gathers the facts.** `tool:read-setup` gathers them: the account's own mechanics from the files door's `setup_facts`, its own show rules and setup context from its records. The operator's shared show rules and setup context were read by old trillion from the service's edge store, which no tool reaches: they are sent to the steps only when `setup_facts` carries them (`shared_rules`, `context`); otherwise they are unknown and the screen stays not ready. The plan-refusal recovery (`plan_sections`, `plan_lead`, `free_decisions`) old /setup/facts added on a 402 is not drawn yet: `tool:see-what-is-left-to-set-up` takes no such input.
- **`setupInstalls`** (trillion `src/setup-installs.mjs`) reads harness and placement records that have not moved; its words come in the request as `installs`.
- **`readSetupPolicy`** is carried but not called: the rules and context come in the request.
- trillion `test/setup-policy.test.mjs` and `test/setup-policy-formula.test.mjs` test the policy with the wasm formula engine and the show-rules store, which have not moved.
- The device rows (`devices.json`), the AI names (`ais.json`) and the service records (`service-records.json`) were read only by the engine's fact readers; they stay in trillion with their own readers (`src/devices.mjs`, `src/ais.mjs`, `src/service-records.mjs`).
