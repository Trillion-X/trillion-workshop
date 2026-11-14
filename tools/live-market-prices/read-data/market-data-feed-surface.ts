// package-set://bitfield-studio/packages/market-data-feed/read-data/market-data-feed-surface.ts

export interface MarketDataFeedBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  accumulated: number;
  volume?: number;
  symbol?: string;
}

export const marketDataFeedSurface = {
  title: 'Market price',
  eyebrow: 'Live bars',
  summary: 'Connect a provider. Real bars appear here; fake candles never do.',
  status: 'no feed',
  emptyTitle: 'Connect market data',
  emptyCopy: 'Add a market provider.',
  setupLabel: 'Connect market data',
  inputName: 'market-bars',
  setupSurface: {
    id: 'service-connections.settings',
    title: 'Outside Accounts and Keys',
    materialTarget: 'service-connections',
    packageEntry: {
      packageName: 'service-connections',
      entryName: 'service-connections',
    },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function readTimestamp(record: Record<string, unknown>): number | null {
  const value = readNumber(record, ['timestamp', 'time', 't']);
  if (value !== null) return value > 10_000_000_000 ? value : value * 1000;
  for (const key of ['at', 'date']) {
    const raw = record[key];
    if (typeof raw !== 'string') continue;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function decodeBar(value: unknown): MarketDataFeedBar | null {
  if (!isRecord(value)) return null;
  const timestamp = readTimestamp(value);
  const open = readNumber(value, ['open', 'o']);
  const high = readNumber(value, ['high', 'h']);
  const low = readNumber(value, ['low', 'l']);
  const close = readNumber(value, ['close', 'c', 'price']);
  if (timestamp === null || open === null || high === null || low === null || close === null) {
    return null;
  }
  const volume = readNumber(value, ['volume', 'v']) ?? undefined;
  return {
    timestamp,
    open,
    high,
    low,
    close,
    accumulated: close,
    ...(volume === undefined ? {} : { volume }),
    symbol: readString(value, 'symbol'),
  };
}

export function decodeMarketDataFeedBars(raw: unknown): MarketDataFeedBar[] {
  const rows = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.bars)
      ? raw.bars
      : [];
  return rows
    .map(decodeBar)
    .filter((bar): bar is MarketDataFeedBar => !!bar)
    .sort((left, right) => left.timestamp - right.timestamp);
}

export function summarizeMarketDataFeedBars(bars: readonly MarketDataFeedBar[]) {
  if (bars.length === 0) {
    return { total: 0, average: 0, min: 0, max: 0, count: 0 };
  }
  const closes = bars.map((bar) => bar.close);
  const total = closes.reduce((sum, value) => sum + value, 0);
  return {
    total,
    average: total / bars.length,
    min: Math.min(...bars.map((bar) => bar.low)),
    max: Math.max(...bars.map((bar) => bar.high)),
    count: bars.reduce((sum, bar) => sum + (bar.volume ?? 1), 0),
  };
}
