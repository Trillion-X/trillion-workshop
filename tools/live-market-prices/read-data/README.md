# market-data-feed/read-data

Pure decoding and data-to-human translation for the Market Data surface inputs.

## Files

| File | Purpose |
|------|---------|
| `market-data-feed-surface.ts` | Decodes caller-provided market OHLC bars (`market-bars` input) into chart buckets; surface copy + the connect-provider intent. |
| `agent-cycle-surface.ts` | Decodes the trading agent's latest decision cycle (`agent-cycle` input) into typed signals/decisions; translates the `hold_reason` enum into a human sentence. |

## Key Types / Functions

| Type / Function | Shape / Signature | Role |
|------|------|------|
| `MarketDataFeedBar` | `{ timestamp, open, high, low, close, accumulated, volume?, symbol? }` | One decoded price bar. |
| `decodeMarketDataFeedBars(raw)` | `unknown → MarketDataFeedBar[]` | Decode + sort bars; invalid rows vanish (no fake points). |
| `AgentSignal` | `{ symbol, momentumPct, buy, held, working }` | One symbol the agent evaluated this cycle. |
| `AgentDecision` | `{ instrument, symbol, underlying, action, qty, notional, momentumPct, httpStatus, orderId }` | One order the agent acted on. |
| `AgentCycle` | `{ equity, dailyPlPct, targetPct, signals[], decisions[], momentumThresholdPct, holdReason, ... }` | The decoded latest cycle. |
| `decodeAgentCycle(raw)` | `unknown → AgentCycle \| null` | Unwraps the attribute-fact envelope, parses `value_json`, returns typed cycle (null when absent/unparseable). The `holdReason` sentence comes from the canonical `holdReasonSentence` (permission-lease). |
| `agentCycleSurface` | const | `inputName: 'agent-cycle'` + section copy. |
| `marketDataFeedSurface` | const | `inputName: 'market-bars'` + connect-provider intent + copy. |

## Dependencies

**Depends on:** `@/packages/permission-lease/read-data/hold-reason` (canonical `holdReasonSentence`). Otherwise pure TS — zero React, zero I/O.
**Depended on by:** `../show/MarketDataFeedPanel.tsx`.

## Rules

- Decode only caller-provided input data. NEVER invent data — absent fields read as null/empty so the surface shows an honest empty/flat state.
- Preserve source honesty: invalid OHLC rows disappear instead of becoming fake chart points; an absent agent cycle yields `null`, never a fabricated signal.
- The `agent-cycle` input reads the live fact `attribute_fact|agent:trading-momentum|last_cycle|type:json`, whose real payload is a STRINGIFIED `value_json` inside an attribute-fact wrapper — `decodeAgentCycle` unwraps both layers.
- Society vocabulary is translated to human language at the data boundary before it reaches the screen: OCC symbols here; the `hold_reason` enum via the canonical `holdReasonSentence` owned by permission-lease (the guardrail domain that owns the code — L098), imported here.
