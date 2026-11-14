# investment-command/read-data

Trading Center read-data owns package-local decoding and workspace layout constants for the `investment-command` cockpit.

The cockpit is built ON the visual-database generic primitive: it PROJECTS the agent fact into visual-database record rows, then decodes a `VisualDatabaseModel` against field/view descriptor DATA (authored at `agent:cockpit-board.*`). There is no bespoke cockpit view-model — WHICH metrics/columns/timeframes render is DATA, so a different agent/venue renders by authoring different descriptors, zero code change.

| File | Purpose |
| --- | --- |
| `investment-command-surface.ts` | Decodes the trading-center recipe and market-bar input without importing market, account, permission, order, or audit owner packages. |
| `read-trading-workspace-layout-state.ts` | Defines the tiled trading workspace layout and validates persisted layout state before the embedded screen arrangement accepts it. |
| `read-trading-agent-cycle.ts` | Self-describing translation boundary: PROJECTS the agent's canonical `last_cycle` fact into a hero record + `rowGroups` (every array-of-objects key projected into record rows, keyed by the fact's OWN name) + the price series + the plain hold-reason line. No view-model type, no metric/signal enum, no privileged array-key name — scalar keys are copied verbatim onto record payloads so the DATA descriptors select + format them. |
| `cockpit-board.ts` | Names the cockpit's visual-database DATA input bindings (`agent:cockpit-board.fields/views/ranges`), builds the hero record directly (bypassing the human-record gate), and decodes the chart-range OptionSpec + the table's row-group `source` from DATA. |

| Key Export | Shape / Signature | Role |
| --- | --- | --- |
| `TRADING_AGENT_CYCLE_INPUT` | `'trading-agent-cycle'` | Input name the cockpit reads the agent fact via `useBitfieldData`. |
| `TRADING_AGENT_CYCLE_BRIDGE_LABEL` | `'agent:trading-momentum.last-cycle'` | Canonical hash-mode bridge label all trading surfaces read. Since 2026-09-09 it is a `record_from_matching_records` row declared in `trade-order/things-to-store-and-run.json`, derived by the loader from the agent's identity-text `last_cycle` fact (match: `table=attribute_fact`, `subject_id=agent:trading-momentum`, `property_id=last_cycle`) and encoded as a one-element `json_array`, which is why every input descriptor reading it carries `value.projection {op: path, path: [0]}`. Nothing republishes it by hand; before that date no producer existed for this label at all, and four surfaces read a label nothing wrote. Used as `value_address_label`, ONE shared address for all trading surfaces (L043). |
| `TRADING_AGENT_CYCLE_FACT_LABEL` | `'attribute_fact\|agent:trading-momentum\|last_cycle\|type:json'` | The underlying raw identity-text fact (non-browser readers read it at address_mode identity_text; browser surfaces use the hash bridge). |
| `projectCockpit(raw)` | `(unknown) => CockpitProjection` | Projects the fact into `{ reported, heroRecord, rowGroups, priceSeries, holdLine }` — a hero record + a row group per array-of-objects key (keyed by the fact's own name) + primitives, NO cockpit view types. `reported=false` when the fact is absent (no fake data). |
| `holdReasonSentence(reason, thresholdPct)` | re-export of the canonical permission-lease translator | Plain-language translation of the agent's hold reason. |
| `COCKPIT_FIELDS_INPUT` / `COCKPIT_VIEWS_INPUT` / `COCKPIT_RANGES_INPUT` | input-name constants | Bind to `agent:cockpit-board.fields/views/ranges` — the hero field descriptors, the watchlist signal fields + table view, and the chart timeframe OptionSpec. |
| `decodeCockpitFields(raw)` | `(unknown) => VisualDatabaseFieldDescriptor[]` | Decodes the hero field descriptors from the fields DATA (re-export of `decodeVisualDatabaseFields`). |
| `buildHeroRecord(row)` | `(CockpitRecordRow \| null) => VisualDatabaseRecord \| null` | Builds the single hero status record directly, bypassing `isHumanRecord` (the hero is system state, not an authored board row). |
| `decodeViewSource(raw)` | `(unknown) => string \| null` | Reads the table view's `source` — which projected `rowGroups` key the table renders. One DATA field; no array key privileged in code. |
| `decodeRangeOptions(raw)` | `(unknown) => CockpitRange[]` | Decodes the chart-range OptionSpec (`{values:[{id,label,order}]}`) into the LineChart range list. |

The workspace layout is package data: `investment-command` arranges owner-fed surfaces, but it does not own their canonical records or inspect their internal storage. The cockpit projection reads the agent's own published fact — it never re-derives positions or re-reads broker internals.

**Depends on:** `things-to-store-and-run.json` (input descriptors), `@/packages/visual-database/read-data` (model + descriptors), `@/packages/permission-lease/read-data/hold-reason` (canonical hold-reason), `@/packages/screen-arrangement/read-data` (layout types). **Depended on by:** `../show/InvestmentCommandPanel.tsx`.

The cockpit field/view/range DATA records (`agent:cockpit-board.*`) are three `record` rows in `../things-to-store-and-run.json` since 2026-09-09, delivered with the package by `make-packages-match-their-source`. Until that day this line said they were "authored via `engine.operation.write-batch`", and no writer anywhere had ever done so: the three input descriptors named labels that no manifest, script, workflow or plan produced, so the cockpit painted an empty hero and an empty watchlist in every app it was installed in. The rows are derived from what the decoder and panel already read: `fields` carries one `headline`, one `delta` and seven `metric` descriptors over the cycle fact's scalar keys with the `shape` names the panel's formatter understands (`money`, `money2`, `signed-percent`, `percent`, `integer`); `views` carries `source: "signals"` plus the three signal columns and one `table` view; `ranges` is a `visual-database.domain` `{values: [...]}`.
