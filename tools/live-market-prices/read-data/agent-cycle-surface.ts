// package-set://bitfield-studio/packages/market-data-feed/read-data/agent-cycle-surface.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure decode + data-to-human translation for the trading agent's latest
// decision cycle. The Market Data surface reads this to show the agent
// THINKING with real numbers: which symbols it evaluated, each symbol's real
// momentum, which cleared the buy gate, and — when it held — the human reason.
//
// The live fact lives at the address:
//   attribute_fact|agent:trading-momentum|last_cycle|type:json
// stored as an attribute-fact wrapper whose `value_json` is a STRINGIFIED JSON
// payload (the agent writes it that way every cycle). This module unwraps both
// layers and exposes typed, presentation-ready values.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. NEVER invent data. Absent fields read as null / empty — the surface then
//    shows an honest empty/flat state, never a fabricated signal or price.
// 2. The hold_reason enum (Society vocabulary) is translated to a full human
//    sentence here, at the data boundary — it never reaches the screen raw.
// 3. This file is pure: zero React, zero I/O, zero engine knowledge beyond the
//    shape the agent writes.
//
// =============================================================================
// =============================================================================
//
// The documentation in this file is a design feature. Do not remove it.
// =============================================================================

import { holdReasonSentence } from '@/packages/permission-lease/read-data/hold-reason';

/** One evaluated symbol from the agent's last cycle. */
export interface AgentSignal {
  /** Ticker the agent evaluated, e.g. "AAPL". */
  symbol: string;
  /** Real momentum the agent measured this cycle, in percent. */
  momentumPct: number | null;
  /** True when this symbol cleared the buy gate this cycle. */
  buy: boolean;
  /** True when the agent already holds a position in this symbol. */
  held: boolean;
  /** True when an order on this symbol is already working (queued/open). */
  working: boolean;
}

/** One order the agent placed (or attempted) this cycle. */
export interface AgentDecision {
  /** "stock" | "option" (whatever the agent recorded). */
  instrument: string | null;
  /** Tradeable symbol, e.g. "AAPL" or an option contract symbol. */
  symbol: string | null;
  /** For options, the human underlying, e.g. "TSLA". */
  underlying: string | null;
  /** "buy" | "sell". */
  action: string | null;
  /** Order quantity, when shares were used. */
  qty: string | null;
  /** Order notional, when dollar sizing was used. */
  notional: number | null;
  /** Momentum that triggered the order, in percent. */
  momentumPct: number | null;
  /** HTTP status the broker returned for this order. */
  httpStatus: number | null;
  /** Broker order id, when accepted. */
  orderId: string | null;
}

/** The decoded latest agent cycle, presentation-ready. */
export interface AgentCycle {
  /** Account equity right now, in dollars. */
  equity: number | null;
  /** Equity at the start of the day, in dollars. */
  lastEquity: number | null;
  /** Cash available to open new positions, in dollars. */
  buyingPower: number | null;
  /** Open-position P&L right now, in dollars. */
  unrealizedPl: number | null;
  /** Today's P&L versus the daily target, in percent. */
  dailyPlPct: number | null;
  /** The daily goal, in percent (5 = "5% a day"). */
  targetPct: number | null;
  /** True when today's P&L has reached the daily target. */
  onTarget: boolean | null;
  /** Number of positions the agent currently holds. */
  positionsCount: number | null;
  /** Number of orders currently queued/open at the broker. */
  openOrders: number | null;
  /** Number of orders the agent placed this cycle. */
  ordersPlaced: number | null;
  /** Momentum a symbol must clear to be bought, in percent. */
  momentumThresholdPct: number | null;
  /** Per-symbol evaluation evidence for this cycle. */
  signals: AgentSignal[];
  /** Orders the agent acted on this cycle. */
  decisions: AgentDecision[];
  /** Human sentence for why the agent held (null when it traded). */
  holdReason: string | null;
  /** When this cycle ran (ms epoch), or null. */
  observedAt: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  return null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readMs(value: unknown): number | null {
  const numeric = readNumber(value);
  if (numeric !== null) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readStringSet(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) return new Set();
  const out = new Set<string>();
  for (const item of value) {
    const symbol = readString(item);
    if (symbol) out.add(symbol);
  }
  return out;
}

/**
 * Unwrap the attribute-fact envelope and parse its stringified `value_json`.
 * Accepts either the raw cycle object (already unwrapped) or the wrapper.
 */
function readCyclePayload(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  // Wrapper form: { property_id, subject_id, table, type_id, value_json: "..." }
  if (typeof raw.value_json === 'string') {
    try {
      const parsed = JSON.parse(raw.value_json);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  // Already-unwrapped form: the cycle object itself.
  if ('equity' in raw || 'signals' in raw || 'cycle_id' in raw) {
    return raw;
  }
  return null;
}

function decodeSignal(
  value: unknown,
  held: ReadonlySet<string>,
  working: ReadonlySet<string>,
): AgentSignal | null {
  if (!isRecord(value)) return null;
  const symbol = readString(value.sym) ?? readString(value.symbol);
  if (!symbol) return null;
  return {
    symbol,
    momentumPct: readNumber(value.momentum_pct),
    buy: readBool(value.buy) ?? false,
    held: held.has(symbol),
    working: working.has(symbol),
  };
}

function decodeDecision(value: unknown): AgentDecision | null {
  if (!isRecord(value)) return null;
  const symbol = readString(value.symbol);
  const underlying = readString(value.underlying);
  if (!symbol && !underlying) return null;
  return {
    instrument: readString(value.instrument),
    symbol,
    underlying,
    // Canonical cycle uses `side`; the prior shape used `action` — accept either.
    action: readString(value.side) ?? readString(value.action),
    qty: readString(value.qty),
    notional: readNumber(value.notional),
    momentumPct: readNumber(value.momentum_pct),
    httpStatus: readNumber(value.http_status),
    orderId: readString(value.order_id),
  };
}

// The hold_reason → sentence translation is owned by permission-lease (the
// guardrail domain that owns the code), imported as `holdReasonSentence`. The
// local copy was deleted (L043/L098 — one owner, one superset).

/** Decode the live agent-cycle input into a typed, presentation-ready cycle. */
export function decodeAgentCycle(raw: unknown): AgentCycle | null {
  const payload = readCyclePayload(raw);
  if (!payload) return null;

  const held = readStringSet(payload.held_symbols);
  const working = readStringSet(payload.working_symbols);

  const signals = Array.isArray(payload.signals)
    ? payload.signals
        .map((item) => decodeSignal(item, held, working))
        .filter((signal): signal is AgentSignal => signal !== null)
    : [];

  const decisions = Array.isArray(payload.decisions)
    ? payload.decisions
        .map(decodeDecision)
        .filter((decision): decision is AgentDecision => decision !== null)
    : [];

  const momentumThresholdPct = readNumber(payload.momentum_threshold_pct);

  return {
    equity: readNumber(payload.equity),
    lastEquity: readNumber(payload.last_equity),
    buyingPower: readNumber(payload.buying_power),
    unrealizedPl: readNumber(payload.unrealized_pl),
    dailyPlPct: readNumber(payload.daily_pl_pct),
    targetPct: readNumber(payload.target_pct),
    onTarget: readBool(payload.on_target),
    positionsCount: readNumber(payload.positions_count),
    openOrders: readNumber(payload.open_orders),
    ordersPlaced: readNumber(payload.orders_placed),
    momentumThresholdPct,
    signals,
    decisions,
    holdReason: holdReasonSentence(readString(payload.hold_reason), momentumThresholdPct),
    observedAt: readMs(payload.ts),
  };
}

/** Presentation facts + the live input wiring for the agent-cycle read. */
export const agentCycleSurface = {
  /**
   * Input name the panel reads via useBitfieldData. Matches the cockpit's
   * canonical `trading-agent-cycle` input so every trading surface reads the
   * same agent cycle fact under one name.
   */
  inputName: 'trading-agent-cycle',
  /** Section copy (user-facing, plain language). */
  moversTitle: 'What the agent evaluated',
  /** Shown when the agent cycle fact exists but carries no evaluated symbols yet. */
  evaluatingTitle: 'Agent is evaluating',
  evaluatingCopy: 'The agent is running its decision cycle. Each symbol it scores appears here.',
  /** Shown only when no agent cycle fact exists at all. */
  noCycleTitle: 'No agent activity yet',
  noCycleCopy: 'Once the trading agent runs a cycle, the symbols it evaluates appear here.',
  buyMarker: 'BUY',
  buyMarkerHint: 'Cleared the buy gate',
} as const;
