# Timed Action Package

`timed-action` is a package source workshop for generic scheduled work.
It declares a Generic Scheduled Action Graph: records, open fields, links, time
windows, rules, action descriptors, owner targets, evidence, receipts, and
maintained projections.

The package does not publish content, collect analytics, manage accounts, read
credentials, run HTTP, spawn processes, or own provider behavior. Those jobs
stay in their existing owner packages. This package prepares descriptor-backed
records; each scheduled-action-action row carries its OWN complete dispatch
config as DATA (`dispatch.name` = any slot address, `dispatch.input` = its
opaque payload), and the blind fire definition re-reads the row and asks
exactly what it names (row-carried dispatch doctrine).

## Source Boundary

- package source: `packages/timed-action`
- package boundary: `things-to-store-and-run.json`
- logic projection: `read-data/read-scheduled-action-graph.ts`
- write builder: `do-work/write-scheduled-action-record.ts`
- due evaluator (pure reduction): `do-work/evaluate-due-scheduled-actions.ts`
- evaluator CLI (compute.process mount): `do-work/process-scripts/evaluate-due-scheduled-actions-cli.ts`
- recurring-window materializer (pure reduction): `do-work/materialize-recurring-windows.ts`
- recurrence storage CLI: `do-work/process-scripts/materialize-recurring-windows-cli.ts`
- durable DATA workflow: `action:timed-action.on-clock-tick-v1` (materialize, then evaluate)

## Recurring window contract

`materializeRecurringWindows` turns generic schedule DATA into one unresolved
occurrence window (two only when a schedule explicitly chooses both sides of a
DST fold). Its stable `occurrence_key` binds the schedule ID, requested and
resolved local windows, IANA timezone, source generation, schedule revision,
and fold branch. A durable caller must compare-and-exchange that exact key when
persisting a materialization: replay, restart, and concurrent ticks then produce
the same write instead of duplicate work.

Only a state carrying complete `owner_outcome` proof (`proven`, `owner_ref`,
`proof_ref`, and `observed_at`) advances the recurrence. A dispatch
acknowledgement, a missing proof, or `proven:false` keeps the same occurrence
active for retry. The durable `run-recurring-owner-v1` workflow accepts only the
explicit `synchronous-owner-return` completion contract: it calls the row-owned
action first, then atomically writes the occurrence outcome and scheduled receipt.
If the owner fails, neither proof exists and the same idempotent occurrence retries.
DST gap/fold behavior is schedule DATA (`dst.gap`, `dst.fold`), never host-local
clock behavior.

## Proof Commands

```bash
node packages/timed-action/__tests__/scheduled-action-projection.test.mjs
node packages/timed-action/__tests__/scheduled-action-commands.test.mjs
node packages/timed-action/__tests__/timed-action-ios-jscore.test.mjs
pnpm exec vitest run packages/timed-action/do-work/materialize-recurring-windows.test.ts
node packages/timed-action/do-work/runtime-recurrence-wiring.test.mjs
node -e "JSON.parse(require('fs').readFileSync('packages/timed-action/things-to-store-and-run.json','utf8'))"
```

The iOS JSCore proof also has an Apple JavaScriptCore framework harness:

```bash
swift /tmp/timed-action-jscore-proof.swift
```

Boundary greps:

```bash
rg -n "ScheduleStatus|CampaignStage|ProviderStatus|PublishOutcome|CalendarEvent|MailMessage|Buffer|Instagram|LinkedIn|TikTok|YouTube|Twitter|X.com" packages/timed-action --glob '!README.md' --glob '!__fixtures__/**'
rg -n "packages/(content-distribution|content-analytics|publish-composer|service-connections|service-connections)" packages/timed-action --glob '!README.md'
```

## Banned Backend Vocabulary

Provider names, fixed lifecycle states, campaign stages, content outcomes,
calendar/mail entities, credential terms, transport terms, and process execution
terms are not backend code here. They can appear only as descriptor data,
fixtures, README boundary explanation, or human-facing copy supplied by data.
