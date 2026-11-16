# autonomous-agent-tick

Zero-source DATA package: the durable autonomous-agent wake — a boot-loaded, package-owned trigger-rule that, on each `clock::tick`, dispatches the real AI turn (`ai-records-producer` `action:run-ai-records-production`) cross-slot.

## Files

| File | Purpose |
|------|---------|
| `things-to-store-and-run.json` | The package DATA: one `trigger-rule` record per autonomous-agent config (row = Config B business operator; the coach row ships with the coach set). |
| `processes/` | The one-shot node scripts the workflow actions run as `compute.process` jobs, plus their per-script tests. Has its own README with the mounting rules and the package invariants. |
| `tests/` | Assertions about the MANIFEST and cross-file wiring, as distinct from a single script's logic. Has its own README explaining the split. |
| `README.md` | This file. |

## Key Records

| Record | Shape / Address | Role |
|--------|-----------------|------|
| `trigger:autonomous-agent-tick:produce-on-clock-tick-operator` | `trigger-rule` at `package::autonomous-agent-tick::trigger-rule::produce-on-clock-tick-operator`, path `[current-item,published-record,trigger-rule]`, partition `runtime-partition` | Matches `$bind envelope.address_text starts_with "clock::tick"` + `is_retraction==false`; dispatches `slot::workflow execute_definition action:run-ai-records-production` with `agent_ref`+`instruction_text` as DATA. |

## Why This Design

The trigger-engine registers a rule ONLY from a **package-owned record boot-loaded at startup** on the `trigger-rule` address path (`trigger-engine/source/src/slot_work/delta_apply.rs:509`, `lib.rs:4-5`). Live ad-hoc admission does not register (verified cont.56). Label-hash workflow-write outputs don't fire triggers, and in-def `execute_definition` deadlocks slot::workflow — so the producer must be dispatched cross-slot by this boot-loaded trigger. Shape proven live by `chat.refresh-live-on-tick` + `timed-action.evaluate-due-on-tick`.

## Dependencies

**Depends on:** `notice-when-something-shows-up` (its clock waiter row emits `clock::tick`; it superseded `clock-ticker` on 2026-09-05 with the record unchanged byte for byte), `trigger-engine` (registers/dispatches the rule), `ai-records-producer` (`action:run-ai-records-production` — the AI turn), `slot::workflow`, `ai-agent-profile` (`autonomous-business-operator` / coach profiles as DATA).
**Depended on by:** nothing (leaf DATA package — features emerge from its composition of the above via the envelope).
