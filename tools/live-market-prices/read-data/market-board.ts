// package-set://bitfield-studio/packages/market-data-feed/read-data/market-board.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The ONE place that knows the agent's current cycle shape. It produces the
// GENERIC `InstrumentBoard` the market surface renders. The renderer (TSX) sees
// only the generic board — never "momentum", "buy", "stock". This adapter is
// the translation boundary (L098): legacy-shape knowledge lives HERE, in data
// terms, and is COMPLETELY BYPASSED the moment the agent writes its own
// self-describing `board` descriptor.
//
// THE GENERIC TEST (mandate): "Could the same surface render an option chain or
// a Polymarket Yes/No market by changing only DATA?" YES — because:
//   - If the cycle fact carries `board: {columns, rows, metrics, series, …}`,
//     we hand it straight to `decodeInstrumentBoard`. The AI declares whatever
//     columns it wants (Strike/IV/Δ, or Outcome/Price¢/Δ) and they render. The
//     renderer never changes.
//   - Otherwise we PROJECT the present cycle into a board PAYLOAD by passing
//     each evaluated instrument's own scalar fields through as generic row
//     fields, plus `field_labels` + `signed_fields` DATA HINTS. We add NO
//     hardcoded column — `decodeInstrumentBoard` derives columns from whatever
//     scalar fields the rows carry. A future cycle that adds `implied_vol` to
//     its signals gets an IV column for free, with zero code change here.
//
// The series chart is fed by whatever the data provides: the cycle's own
// `board.series` when present, else the live price bars projected to points.
//
// =============================================================================
// AUTHORING NOTE
// =============================================================================
//
// The documentation in this file is a design feature. Do not remove it.
// =============================================================================

import { decodeInstrumentBoard, type InstrumentBoard } from './instrument-board.ts';
import type { AgentCycle } from './agent-cycle-surface.ts';
import type { MarketDataFeedBar } from './market-data-feed-surface.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Unwrap the attribute-fact envelope to the raw cycle object, mirroring
 *  agent-cycle-surface's reader so we can look for an explicit `board`. */
function rawCycleObject(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.value_json === 'string') {
    try {
      const parsed = JSON.parse(raw.value_json);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return raw;
}

/** Project live bars into a generic series payload (the data the chart plots).
 *  The headline value + delta are derived from the bars themselves. */
function seriesPayloadFromBars(bars: readonly MarketDataFeedBar[]): Record<string, unknown> | null {
  if (bars.length === 0) return null;
  const first = bars[0];
  const last = bars[bars.length - 1];
  const abs = last.close - first.open;
  const pct = first.open !== 0 ? (abs / first.open) * 100 : 0;
  const tone = abs > 0 ? 'success' : abs < 0 ? 'error' : 'neutral';
  const fmt = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const deltaText = `${abs >= 0 ? '+' : ''}${abs.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
  return {
    points: bars.map((bar) => ({ value: bar.close, t: bar.timestamp })),
    title: last.symbol ?? null,
    headline_value: fmt(last.close),
    delta_text: deltaText,
    tone,
    value_prefix: '$',
  };
}

/**
 * Build the generic `InstrumentBoard` for the market surface from whatever the
 * data provides. EXPLICIT board descriptor wins; otherwise project the current
 * cycle's evaluated instruments + the price bars into a generic board payload.
 */
export function buildMarketBoard(
  rawCycle: unknown,
  cycle: AgentCycle | null,
  bars: readonly MarketDataFeedBar[],
  fallbackTitle: string,
): InstrumentBoard {
  const cycleObject = rawCycleObject(rawCycle);
  const series = seriesPayloadFromBars(bars);

  // 1. EXPLICIT — the agent declared its own self-describing board. Render it
  //    verbatim; the chart uses the board's own series when present, else bars.
  if (cycleObject && isRecord(cycleObject.board)) {
    const board = { ...cycleObject.board } as Record<string, unknown>;
    if (!isRecord(board.series) && series) board.series = series;
    return decodeInstrumentBoard(board, { title: fallbackTitle });
  }

  // 2. PROJECTED — pass each evaluated instrument's OWN scalar fields through as
  //    generic row fields. We attach DATA HINTS (labels + signed) but hardcode
  //    NO column: decodeInstrumentBoard derives columns from the rows' scalars.
  //    Each row is the instrument's self-describing field bag, plus a generic
  //    marker/state the data already implies.
  const rawSignals = cycleObject && Array.isArray(cycleObject.signals) ? cycleObject.signals : [];
  const held = cycle ? new Set(cycle.signals.filter((s) => s.held).map((s) => s.symbol)) : new Set<string>();
  const working = cycle ? new Set(cycle.signals.filter((s) => s.working).map((s) => s.symbol)) : new Set<string>();
  const buyMarker = cycleObject && typeof cycleObject.buy_marker === 'string' ? cycleObject.buy_marker : 'Buy';

  const rows = rawSignals
    .filter(isRecord)
    .map((signal) => {
      // Carry the instrument's scalar fields through unchanged (minus the flags
      // we translate into a marker/state). decodeInstrumentBoard turns whatever
      // remains into columns. We do not name any of them in code.
      const { buy, held: _h, working: _w, sym, symbol, ...scalarFields } = signal as Record<string, unknown>;
      const identity = (typeof sym === 'string' && sym) || (typeof symbol === 'string' && symbol) || '';
      const isHeld = identity ? held.has(identity) : false;
      const isWorking = identity ? working.has(identity) : false;
      const row: Record<string, unknown> = { symbol: identity, ...scalarFields };
      if (buy === true) row.marker = { label: buyMarker, tone: 'success' };
      else if (isHeld) row.state = 'Holding';
      else if (isWorking) row.state = 'Order working';
      return row;
    });

  // DATA HINTS that travel WITH the payload (not hardcoded in the renderer):
  // human labels + which fields are signed. The agent can override these by
  // writing its own `board`. These describe the CURRENT cycle's fields only.
  const presentKeys = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) presentKeys.add(key);
  const fieldLabels: Record<string, string> = {};
  const signedFields: string[] = [];
  if (presentKeys.has('momentum_pct')) {
    fieldLabels.momentum_pct = 'Momentum';
    signedFields.push('momentum_pct');
  }

  const metrics = projectedMetrics(cycle);

  const payload: Record<string, unknown> = {
    title: fallbackTitle,
    rows,
    field_labels: fieldLabels,
    signed_fields: signedFields,
    metrics,
    note: cycle?.holdReason ?? null,
  };
  if (series) payload.series = series;

  return decodeInstrumentBoard(payload, { title: fallbackTitle });
}

/** The metric strip cells for the legacy momentum cycle, as generic data. When
 *  the agent writes its own `board.metrics`, this is bypassed. */
function projectedMetrics(cycle: AgentCycle | null): Array<Record<string, unknown>> {
  if (!cycle) return [];
  const cleared = cycle.signals.filter((s) => s.buy).length;
  const metrics: Array<Record<string, unknown>> = [
    { label: 'Instruments evaluated', value: cycle.signals.length },
    { label: 'Cleared the gate', value: cleared, tone: cleared > 0 ? 'success' : 'neutral' },
  ];
  if (cycle.momentumThresholdPct !== null) {
    metrics.push({ label: 'Buy gate', text: `${cycle.momentumThresholdPct}%` });
  }
  return metrics;
}
