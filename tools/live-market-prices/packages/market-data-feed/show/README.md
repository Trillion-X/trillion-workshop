# market-data-feed/show/

Market surface for the trading cockpit — a fey.com stock-detail clone: symbol header + thin price line chart + the autonomous agent's real-number scan.

## Files

| File | Purpose |
|------|---------|
| `MarketDataFeedPanel.tsx` | The market panel: symbol header (ticker + mono price + green/red delta), the shared fey `LineChart` hero, and the agent-scan section (`MetricRow` + per-symbol evaluation rows). |
| `mount-market-data-feed.tsx` | Mounts `MarketDataFeedPanel` inside a `FloatingMaterialFrame` + `ErrorBoundary`; the package entry's render target. |

## Key Types / Functions

| Export | Signature / Shape | Role |
|--------|-------------------|------|
| `MarketDataFeedPanel` | `() => JSX` | Reads live bars (`market-bars`) + agent cycle (`trading-agent-cycle`) via `useBitfieldData`; renders the three fey zones. Honest empty/loading when data is absent. |
| `mount` (default) | `({ el, props }) => unmount` | Package entry mount. |

## Anatomy (reference: fey stock detail)

1. **Symbol header** — ticker + eyebrow, large mono price, signed green/red delta (latest close vs the window's first open). Derived only from real bars.
2. **Price chart** — `@/packages/ui` `LineChart` hero tier: one thin line + soft tone gradient, minimal axis, plain-text timeframe row. NEVER a barcode/candlestick.
3. **Agent scan** — `MetricRow` (symbols evaluated / cleared the gate / buy gate) over quiet hairline-divided per-symbol rows; the human hold reason when the agent held.

## Invariants

- REAL DATA ONLY — no fabricated price, curve, or signal; absent data shows an honest empty/loading state.
- ZERO inline style (L065/L066) — all layout via `Container`/`Card` props; no `className`, no raw HTML in this feature file.
- Society vocabulary (hold_reason enum) is translated to human language in `read-data` before it reaches this file.

## Dependencies

**Depends on:** `@/packages/ui` (`LineChart`, `MetricRow`, `Card`, `Container`, `Text`, `Badge`, `Icon`, `Divider`, `ScrollableSurface`), `@bitfield/runtime-kit/react` (`useBitfieldData`), `../read-data/market-data-feed-surface`, `../read-data/agent-cycle-surface`, `lucide-react`.
**Depended on by:** the `market-data-feed` package entry (`entry-to-package-data-map.json` → `mount-market-data-feed.tsx`).
