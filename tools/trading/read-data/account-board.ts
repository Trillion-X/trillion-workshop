// package-set://bitfield-studio/packages/portfolio-connector/read-data/account-board.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The Account surface, built ON the visual-database generic primitive — NOT bespoke
// trading components. This module is the self-describing translation boundary
// (L098): it turns the live trading-agent cycle fact into visual-database record
// shapes the generic primitives render. It carries ZERO fixed field/column sets
// and ZERO domain enum literals — the surface renders whatever the DATA describes.
//
// Three thin, pure helpers (mirrors trade-order/read-data/order-capability.ts):
//
//   1. unwrapAccountCycle — peel the EEAF `value_json` envelope to the inner
//      self-describing cycle object (or pass an already-unwrapped object).
//   2. projectAccountRecord — project the cycle's account fields into ONE record-
//      board record. Its payload IS the cycle's own key→value scalars, so the
//      balances strip (RecordMetricRow over metric descriptors) and the hero
//      headline read whatever the account reports. A Schwab `margin_buying_power`
//      key flows through with zero code change.
//   3. projectPositionRecords — project the cycle's `positions[]` (each a self-
//      describing object) into visual-database records for the holdings table. Each
//      record's payload IS the position's own keys, so an options position's
//      strike/expiry or a futures contract's month appear as columns by DATA.
//
// WHICH metrics/columns surface + their labels/format/tone/order are DATA (the
// descriptor records authored at the account-board bridge labels); discovery from
// the payload's own keys is the floor (visual-database's discovered-fields), so a
// field with no descriptor still renders. The hero figure (equity), today's
// change, the equity line, and the goal are the account's intrinsic identity,
// read by named accessor — they are the ONE thing every account of every broker
// has exactly one of, not an extensible set.
//
// THE GENERIC TEST: point this at a Schwab account, an options portfolio, or a
// futures account by authoring different descriptor DATA + the broker reporting
// its own fields — ZERO change here. No 'equity'/'shares'/'buy'/'paper' fixed set.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

// ---------------------------------------------------------------------------
// Static package-owned screen copy (no live data)
// ---------------------------------------------------------------------------

/** Package-owned static copy: the guardrail sentences, the not-connected call-
 *  to-action, and where "Connect broker" routes. Plain language only — never
 *  role codes, lease/owner vocabulary, or storage mechanics. */
export const accountSurfaceCopy = {
  notConnected: {
    title: 'Connect a broker account',
    summary: 'Add a broker connection to see live account value, positions, and the agent working your orders.',
    setupLabel: 'Connect broker',
  },
  setupSurface: {
    id: 'service-connections.settings',
    title: 'Outside Accounts and Keys',
    materialTarget: 'service-connections',
    packageEntry: { packageName: 'service-connections', entryName: 'service-connections' },
  },
  guardrails: [
    'Every order is checked before it can go live.',
    'Paper trading until you choose to flip live.',
  ],
} as const;

// ---------------------------------------------------------------------------
// Live input wiring (SSOT for the inputs the Account surface reads)
// ---------------------------------------------------------------------------

/**
 * Live cycle input — the agent's per-cycle account fact, republished to a HASH-
 * mode bridge label (the in-browser useBitfieldData read resolves HASH only; the
 * agent's canonical fact is at an identity_text address it cannot read). The ONE
 * canonical bridge shared by all trading surfaces. Binding descriptor lives in
 * things-to-store-and-run.json (`package::portfolio-connector::input::account-cycle`).
 */
export const accountCycleInput = {
  inputName: 'account-cycle',
  bridgeAddressLabel: 'agent:trading-momentum.last-cycle',
} as const;

/**
 * The Account surface is built on visual-database. These inputs carry the self-
 * describing visual-database DATA the surface reads (authored via write-batch at the
 * hash-mode labels below; binding descriptors in things-to-store-and-run.json):
 *
 *  - `account-metrics` → metric FIELD DESCRIPTORS for the balances strip (which
 *    figures, their labels, format, tone, order). DATA, never TSX literals.
 *  - `account-fields`  → FIELD DESCRIPTORS for the holdings table COLUMNS + any
 *    choice-field option domains (e.g. a position-state badge). Columns are DATA.
 *  - `account-views`   → the visual-database VIEW(S) — the holdings table.
 *
 * Pointing the surface at Schwab options / a futures account is a DATA change to
 * these records (and the broker reporting its fields) — ZERO change to the TSX.
 */
export const accountMetricsInput = {
  inputName: 'account-metrics',
  bridgeAddressLabel: 'account:board.metrics',
} as const;

export const accountFieldsInput = {
  inputName: 'account-fields',
  bridgeAddressLabel: 'account:board.fields',
} as const;

export const accountViewsInput = {
  inputName: 'account-views',
  bridgeAddressLabel: 'account:board.views',
} as const;

// ---------------------------------------------------------------------------
// Decoded headline (the hero figure — the account's intrinsic identity)
// ---------------------------------------------------------------------------

export type AccountTone = 'up' | 'down' | 'neutral';

/** The hero: the account's headline value + today's signed change + goal + the
 *  intraday equity series for the line. Built from the cycle's intrinsic figures
 *  (the ONE total-value + day-P&L every account has), never a field SET. */
export interface AccountHeadline {
  /** True when a live cycle fact was present and parsed. */
  readonly live: boolean;
  /** Account value, pre-formatted (e.g. "$100,000.00"). null → not reported. */
  readonly value: string | null;
  /** Today's signed change in value, pre-formatted (e.g. "+$1,204.00"). */
  readonly deltaValue: string | null;
  /** Today's change percent, pre-formatted (e.g. "+1.20%"). */
  readonly deltaPct: string | null;
  /** Tone of the day (drives green/red + the line tone). */
  readonly deltaTone: AccountTone;
  /** Plain-language goal line (e.g. "On pace · 24% of the 5% daily goal"). */
  readonly goalLabel: string | null;
  /** Progress toward the daily goal, clamped 0..100 (for the thin bar). null = no goal. */
  readonly goalProgressPct: number | null;
  /** Intraday equity series (oldest → newest) for the LineChart. <2 points → flat baseline. */
  readonly equitySeries: readonly number[];
}

// ---------------------------------------------------------------------------
// Decode helpers (pure)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

/**
 * Peel the live entry to the inner self-describing cycle object. The fact arrives
 * wrapped in the EEAF attribute-fact envelope (`{ ..., value_json }` where the
 * payload is a JSON string), or already unwrapped. Both normalize to the inner
 * object; anything else → null (honest "no cycle").
 */
export function unwrapAccountCycle(entry: unknown): Record<string, unknown> | null {
  if (!isRecord(entry)) return null;
  if (typeof entry.value_json === 'string') {
    try {
      const parsed = JSON.parse(entry.value_json);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  // Already-unwrapped cycle object — recognized by any of its own fields.
  if ('equity' in entry || 'cycle_id' in entry || 'daily_pl_pct' in entry || 'buying_power' in entry) {
    return entry;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Formatting (presentation — the data owner's, not visual-database's)
// ---------------------------------------------------------------------------

/** Format a USD amount, e.g. "$100,000.00" / "+$1,204.00". null → "—". */
export function formatUsd(value: number | null, opts?: { decimals?: number; sign?: boolean }): string {
  if (value == null) return '—';
  const decimals = opts?.decimals ?? 2;
  const sign = opts?.sign && value > 0 ? '+' : '';
  return `${sign}${value < 0 ? '-' : ''}$${Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/** Format a percent with a sign, e.g. "+1.20%" / "-0.40%". null → "—". */
export function formatPct(value: number | null, opts?: { decimals?: number }): string {
  if (value == null) return '—';
  const decimals = opts?.decimals ?? 2;
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

function toneFromSign(value: number | null): AccountTone {
  if (value == null || value === 0) return 'neutral';
  return value > 0 ? 'up' : 'down';
}

// ---------------------------------------------------------------------------
// 1. Headline (hero) — intrinsic identity figures
// ---------------------------------------------------------------------------

/**
 * Build the hero headline from the cycle's intrinsic figures. Equity is the
 * account's single total value; the day change is derived from equity vs prior
 * close (or the agent's reported `daily_pl_pct`); the goal line is the configured
 * `target_pct` made plain. Honest nulls when figures are absent. This reads named
 * intrinsic keys (the ONE value/P&L every account has) — it is NOT a field SET.
 */
export function decodeAccountHeadline(cycle: Record<string, unknown> | null): AccountHeadline {
  if (!cycle) {
    return {
      live: false, value: null, deltaValue: null, deltaPct: null, deltaTone: 'neutral',
      goalLabel: null, goalProgressPct: null, equitySeries: [],
    };
  }
  const equity = readNumber(cycle.equity);
  const lastEquity = readNumber(cycle.last_equity);
  const dailyPlPct = readNumber(cycle.daily_pl_pct);
  const dailyChange = equity != null && lastEquity != null ? equity - lastEquity : null;
  const targetPct = readNumber(cycle.target_pct);
  const onTarget = readBoolean(cycle.on_target);

  let goalProgressPct: number | null = null;
  if (dailyPlPct != null && targetPct != null && targetPct > 0) {
    goalProgressPct = Math.max(0, Math.min(100, (dailyPlPct / targetPct) * 100));
  }
  const goalLabel = targetPct != null
    ? (onTarget
      ? `On pace · ${targetPct}% daily goal`
      : goalProgressPct == null
        ? `Targeting ${targetPct}% a day`
        : `${Math.round(goalProgressPct)}% of the ${targetPct}% daily goal`)
    : null;

  return {
    live: true,
    value: equity != null ? formatUsd(equity) : null,
    deltaValue: dailyChange != null ? formatUsd(dailyChange, { sign: true }) : null,
    deltaPct: dailyPlPct != null ? formatPct(dailyPlPct) : null,
    deltaTone: toneFromSign(dailyPlPct ?? dailyChange),
    goalLabel,
    goalProgressPct,
    equitySeries: decodeEquitySeries(cycle, equity, lastEquity),
  };
}

/**
 * The hero LineChart series: the agent's intraday equity curve when it published
 * one (`equity_curve`/`equity_series`, numbers or `{equity}`/`{value}` points),
 * else the honest two-point day path (prior close → now), else a single point
 * (LineChart then renders its flat baseline). Never invents data.
 */
function decodeEquitySeries(
  cycle: Record<string, unknown>,
  equity: number | null,
  lastEquity: number | null,
): number[] {
  const raw = cycle.equity_curve ?? cycle.equity_series;
  if (Array.isArray(raw)) {
    const series: number[] = [];
    for (const point of raw) {
      const value = typeof point === 'number'
        ? (Number.isFinite(point) ? point : null)
        : isRecord(point)
          ? (readNumber(point.equity) ?? readNumber(point.value))
          : null;
      if (value != null) series.push(value);
    }
    if (series.length >= 2) return series;
  }
  if (lastEquity != null && equity != null) return [lastEquity, equity];
  return equity != null ? [equity] : [];
}

// ---------------------------------------------------------------------------
// 2. Account record (the balances strip + status pill source)
// ---------------------------------------------------------------------------

/**
 * Project the cycle's account fields into ONE visual-database record. The payload IS
 * the cycle's own scalar key→value entries (numbers/strings/booleans), so the
 * metric descriptors (DATA) read whatever figures the account reports — a new
 * broker field appears as a metric by DATA alone. `held_symbols`/`working_symbols`
 * /`signals`/`positions`/`decisions` are array structures handled elsewhere, not
 * scalar metrics, so they are excluded from this record's scalar payload.
 *
 * Returns the array `decodeVisualDatabaseModel` accepts directly (a single record).
 */
const ACCOUNT_NON_SCALAR_KEYS: ReadonlySet<string> = new Set([
  'positions', 'held_symbols', 'working_symbols', 'signals', 'decisions',
  'equity_curve', 'equity_series', 'narratives', 'metrics',
]);

export function projectAccountRecord(cycle: Record<string, unknown> | null): readonly Record<string, unknown>[] {
  if (!cycle) return [];
  const payload: Record<string, unknown> = { id: 'account' };
  for (const [key, value] of Object.entries(cycle)) {
    if (ACCOUNT_NON_SCALAR_KEYS.has(key)) continue;
    // Keep scalars only — the metric strip renders scalar figures.
    if (value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      payload[key] = value;
    }
  }
  return [{ id: 'account', payload }];
}

// ---------------------------------------------------------------------------
// 3. Position records (the holdings table)
// ---------------------------------------------------------------------------

/**
 * Project the cycle's `positions[]` into visual-database records for the holdings
 * table. Each record's payload IS the position object's own keys, so the table
 * columns (from the field descriptors / discovered keys) render whatever the
 * broker reports per position — an options position's strike/expiry/greeks or a
 * futures contract's month appear as columns by DATA, zero code change. A `symbol`
 * (or `id`) is used as the record id; absent → index-keyed (honest, still renders).
 *
 * When the agent reports no positions, returns [] — the surface shows a premium
 * honest empty state (never fabricated rows).
 */
export function projectPositionRecords(cycle: Record<string, unknown> | null): readonly Record<string, unknown>[] {
  if (!cycle || !Array.isArray(cycle.positions)) return [];
  const records: Record<string, unknown>[] = [];
  cycle.positions.forEach((position, index) => {
    if (!isRecord(position)) return;
    const symbol = typeof position.symbol === 'string' && position.symbol.trim() !== ''
      ? position.symbol.trim()
      : typeof position.id === 'string' && position.id.trim() !== ''
        ? position.id.trim()
        : `position-${index}`;
    // An option contract (OCC symbol) also reads as a person's label: "AAPL $150 Call · Jan 16 '26".
    const label = parseOccSymbol(symbol) ? humanLabelForSymbol(symbol) : undefined;
    records.push({ id: symbol, payload: { ...position, id: symbol, ...(label ? { label } : {}) } });
  });
  return records;
}

// ---------------------------------------------------------------------------
// 4. Account board read (the one tool row's answer)
// ---------------------------------------------------------------------------

/**
 * The account board from the live trading-agent cycle: the hero headline, the account's own scalar figures and the
 * holdings records. `cycle` is the fact as the store holds it (its value_json envelope) or the cycle object itself.
 * Pure: nothing is kept, sent or read here. A missing or unreadable cycle answers live: false with nothing in it.
 */
export function accountBoardOf(input: { cycle?: unknown } = {}) {
  const cycle = unwrapAccountCycle(input?.cycle);
  return {
    live: cycle !== null,
    headline: decodeAccountHeadline(cycle),
    account: projectAccountRecord(cycle)[0]?.payload ?? null,
    positions: projectPositionRecords(cycle),
  };
}

// ---------------------------------------------------------------------------
// 5. OCC option symbol -> human label (a person reads this, never the raw OCC symbol)
// ---------------------------------------------------------------------------

const OCC_PATTERN = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export interface ParsedOcc {
  readonly underlying: string;
  readonly strike: number;
  readonly expiry: string;
  readonly right: 'Call' | 'Put';
}

/** Parse an OCC option symbol (AAPL260116C00150000). Null for a plain ticker. */
export function parseOccSymbol(symbol: string): ParsedOcc | null {
  const match = OCC_PATTERN.exec(symbol);
  if (!match) return null;
  const [, underlying, yy, mm, dd, right, strikeRaw] = match;
  return {
    underlying: underlying!,
    strike: Number(strikeRaw) / 1000,
    expiry: `20${yy}-${mm}-${dd}`,
    right: right === 'C' ? 'Call' : 'Put',
  };
}

/** Any broker symbol as a label a person reads: "AAPL $150 Call · Jan 16 '26"; a plain ticker is returned as it is. */
export function humanLabelForSymbol(symbol: string): string {
  const occ = parseOccSymbol(symbol);
  if (!occ) return symbol;
  const [fullYear, mm, dd] = occ.expiry.split('-');
  const yy = fullYear!.slice(2);
  const monthIndex = Number(mm) - 1;
  const monthName = monthIndex >= 0 && monthIndex < 12 ? MONTHS[monthIndex] : mm;
  const strikeText = Number.isInteger(occ.strike) ? `$${occ.strike}` : `$${occ.strike.toFixed(2)}`;
  return `${occ.underlying} ${strikeText} ${occ.right} · ${monthName} ${Number(dd)} '${yy}`;
}

// ---------------------------------------------------------------------------
// Metric formatting for RecordMetricRow (descriptor-driven, no field-id literals)
// ---------------------------------------------------------------------------

import type { VisualDatabaseFieldDescriptor } from '../../keep-lists-of-rows/read-data/visual-database';
import type { RecordMetricFormat } from '../../keep-lists-of-rows/show/RecordMetricRow';

/**
 * Turn one metric descriptor's raw value into a display string + tone for the
 * balances RecordMetricRow. Presentation is driven by the descriptor's own hints
 * carried IN the data — `descriptor.shape` ('money' | 'integer' | 'percent' |
 * 'signed-money' | 'signed-percent') selects formatting, and a 'signed-*' shape
 * opts the cell into gain/loss tone. There is NO field-id branching here, so a
 * new metric is a descriptor row, never a code edit. A descriptor that names no
 * shape is money; one that names a shape this formatter does not draw shows its
 * value as it is, never as dollars it may not be.
 */
export function formatAccountMetric(value: unknown, descriptor: VisualDatabaseFieldDescriptor): RecordMetricFormat {
  const shape = descriptor.shape ?? 'money';
  const num = readNumber(value);
  const signed = shape === 'signed-money' || shape === 'signed-percent';
  const tone: RecordMetricFormat['tone'] = signed ? (num == null || num === 0 ? 'neutral' : num > 0 ? 'success' : 'error') : 'neutral';
  switch (shape) {
    case 'integer':
      return { value: num == null ? '—' : Math.round(num).toLocaleString('en-US'), tone };
    case 'percent':
      return { value: formatPct(num), tone };
    case 'signed-percent':
      return { value: formatPct(num), tone };
    case 'signed-money':
      return { value: formatUsd(num, { sign: true }), tone };
    case 'money':
      return { value: formatUsd(num), tone };
    case 'text':
    default:
      return { value: value == null || value === '' ? '—' : String(value), tone };
  }
}
