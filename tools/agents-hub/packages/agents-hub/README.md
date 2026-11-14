# agents-hub

One surface to see, configure, compose, and message every AI agent: a responsive card grid with search/filters/multi-select, a quick-view modal with inline message dispatch, and a full edit view with a provider-grouped model picker and drag-to-reorder instruction blocks.

## Files

| File | Purpose |
|---|---|
| `things-to-store-and-run.json` | Package boundary: checks descriptor (the two vitest suites the owner runner executes), inputs (published-records, chat-sessions, agent-memory-facts), capability-icons config record, message-dispatch config record, placeable-surface ("Agents"), entry. The former `providers` cell-table input is gone: provider identity is an `ai-provider-option` published record read blind by kind, published by whichever package authors the `provider_ref` (today `ai-cli-launch-adapters`) |
| `index.ts` | Barrel export |
| `read-data/resolve-agent-cards.ts` | Blind decoders (profiles, model descriptors, blocks, tools, runs, memories, provider options, sessions, configs) + the pure join to `AgentCardViewModel[]` + formatters |
| `read-data/resolve-agent-cards.test.ts` | Join/decoder unit + golden tests |
| `do-work/agent-record-writes.ts` | THE mutation: full `ai-agent-profile` record via engine write-batch at the record's source address (create/edit/duplicate/archive/restore/delete are configurations of this one write) |
| `do-work/agent-record-writes.test.ts` | Write-batch unit tests |
| `do-work/dispatch-agent-message.ts` | Blind message dispatch: workflow `execute_definition` with the definition id read from this package's own config record |
| `do-work/dispatch-agent-message.test.ts` | Dispatch unit tests |
| `do-work/README.md` | do-work folder index (agent mutations + message dispatch) |
| `show/AgentsHubSurface.tsx` | Main surface: feeds → view models, search, Active/Archived filter, selection + bulk bar, modals |
| `show/AgentCard.tsx` | Card: SelectableAvatar, name, 2-line description, model + local/cloud mark, capability icons, usage row, overflow menu (icon/tint data items) |
| `show/AgentQuickView.tsx` | Quick view: stat strip, capability icons, tools, ordered instructions, memories, message input + send, "See everything" → manager |
| `show/AgentManagerView.tsx` | Owner-composed manager: left rail · Profile/Tools/Models/Runs/Memory/Instructions/Permissions tabs · right detail; selected agent persists across tabs; phone-narrow stacked layout (ui useNarrowViewport) |
| `show/AgentEditView.tsx` | Edit/create: identity, grouped model picker (capabilities + local/cloud per row), DragReorderList instructions + block picker, tool pills, unsaved-changes Save/Clear |
| `show/mount-agents-hub.tsx` | Material mount (FloatingMaterialFrame + ErrorBoundary) |
| `entry-to-package-data-map.json` | Entry → package data map |

## Key Types

| Type | Shape | Role |
|---|---|---|
| `AgentCardViewModel` | id, name, description, archived, modelLabel, vendor, placement{icon,label}, capabilityIcons[], toolLabels[], instructionBlocks[], runCount, totalCost, totalUnits, conversationCount, profile | Pure derived card model; `placement` is where the model runs, resolved by `resolvePlacement` |
| `ModelRuntimeRecord` | runtime_id, deployment_class? | A published `ai-model-runtime-descriptor`, the thing a model executes on, with the runtime owner's own word for where it lives |
| `PlacementMark` | icon, label | How one placement is painted; a DATA row per `deployment_class` plus one `unknown_placement` row for a model whose runtime nobody published |
| `resolvePlacement(model, runtimeById, config)` | `PlacementMark` | First `runtime_refs` entry whose published class has a mark row wins; anything else is the unknown row. Names no class, no vendor, no runtime |
| `AgentProfileRecord` | id, label?, description?, status?, model_refs[], tool_refs[], instruction_refs[], instruction_selection?, memory_refs[], guard_ref?, process_launch?, source_address? | The agent record; `instruction_refs` order IS the membership truth; optional `instruction_selection` preserves versioned bounded include/exclude lineage without replacing membership; optional `process_launch` is the profile-owned launch policy consumed by AI Work Control; `source_address` is the write-back address |
| `CapabilityIconConfig` | icons[{capability,icon,label}], vendor_fallback[{vendor,capabilities[]}], placement_marks[{deployment_class,mark}], unknown_placement | Society data for icon mapping; extending = data change. `local_vendors` was deleted 2026-09-05: inferring where a model runs from who made it marked Alibaba's Qwen, served from this Mac through Ollama, as Cloud |
| `MessageDispatchConfig` | definition_id, default_team, from | Society data naming the dispatch definition |
| `PermissionRow` | id, label, allowed, reason?, subject_ref? | Pairs `ai-guard-limit` + `ai-guard-state` records (blind, by shared id suffix) into human Allowed/Blocked rows |

## Dependencies

**Depends on:** `@/packages/ui` (pure parts only), `@bitfield/runtime-kit` (+`/protocol`, `/react`). Zero feature-package imports. DATA seam, no import: `ai-provider-option` published records (`provider_id` must equal a model descriptor's `provider_ref` byte for byte, and rows missing `vendor` are dropped) supply vendor, local/cloud marking, capability fallback and model-picker group labels.
**Depended on by:** nothing — placeable surface.

## Invariants

1. All reads are blind `{address, payload}` rows discriminated by `payload.kind` — the hub never imports another package's code or contract.
2. All profile writes carry the COMPLETE record to the record's own source address (no patches, no merge code, no re-derived labels).
3. Message dispatch goes to `slot::workflow` with a definition id carried as package DATA; the consumer of the resulting inbox record is unknown to the hub by design.
4. No internal vocabulary in visible text; real data or honest empty states only.
5. Profile-owned launch policy is data on the `ai-agent-profile` record and is preserved by read/write flows; execution remains owned by AI Work Control and `process-session`.
