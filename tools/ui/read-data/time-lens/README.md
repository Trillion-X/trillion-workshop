# time-lens

Shared pure leaf: projects ANY record rows into normalized time blocks via `time-block-lens` DATA descriptors — the one selector grammar consumed by every time-axis geometry (calendar grid, visual-database timeline stream, graph time-filters).

| File | Purpose |
|---|---|
| `time-lens.ts` | Descriptor/selector grammar, `projectTimeLensBlock`, `readTimeLensBlocks` (merge + window + frontier), `validateTimeLensDescriptor` (authoring dry-run guard) |
| `time-lens.test.ts` | Gauntlet tests: selector-miss skip, instant events, windowing, merged sources, ordering, validation |

## Key Types / Functions

| Type | Shape | Role |
|---|---|---|
| `TimeLensDescriptor` | `{kind:'time-block-lens', lens_id, input_address, owner_ref, selectors{identity,start,end?,…}, relations?}` | One DATA row = one time source |
| `TimeLensBlock` | `{id, source, interval{start,end,allDay,timezone}, display{title,color,ownerLabel}, state{ref,lane}, relations}` | Normalized block every renderer sees |
| `TimeLensWindow` | `{start?, end?, mostRecent?}` | Windowed/frontier read boundary |
| `readTimeLensBlocks(lenses, rowsByAddress, window?)` | → `{blocks, diagnostics}` | Merge N lenses, chronological, deterministic |
| `validateTimeLensDescriptor(value)` | throws on bad DATA | Authoring-time guard against silently-dropped records |

## Dependencies

**Depends on:** nothing (pure leaf, zero I/O).
**Depended on by:** calendar (grid geometry — same grammar in `calendar/read-data/read-calendar-time-blocks.ts`, migrating here), visual-database timeline (stream geometry), knowledge-graph time filters.
