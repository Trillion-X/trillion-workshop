// package-set://bitfield-studio/packages/investment-command/read-data/investment-command-surface.ts
//
// Trading Center is a cockpit over package-owned inputs. It never
// imports market-data, portfolio, permission, order, or audit owner source.

import investmentCommandContract from '../things-to-store-and-run.json';

export interface InvestmentCommandOwnerRef {
  id: string;
  label: string;
  status: string;
  role: string;
  surfaceRef?: string;
}

export interface InvestmentCommandActionRecipe {
  label: string;
  target: string;
  definitionId: string;
  includeSteps: boolean;
  includeOutput: boolean;
  input: Record<string, unknown>;
}

export interface InvestmentCommandSurfaceRecipe {
  kind: string;
  title: string;
  eyebrow: string;
  emptyTitle: string;
  emptyCopy: string;
  liveTitle: string;
  setupLabel: string;
  marketBarsInput: string;
  setupSurface: {
    id: string;
    title: string;
    materialTarget: string;
    packageEntry: {
      packageName: string;
      entryName: string;
    };
  };
  primaryAction: InvestmentCommandActionRecipe;
  ownerRefs: InvestmentCommandOwnerRef[];
}

export interface InvestmentMarketBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  accumulated: number;
  volume?: number;
  symbol?: string;
}

export interface InvestmentMarketSummary {
  total: number;
  average: number;
  min: number;
  max: number;
  count: number;
  latest: number | null;
  symbol: string | null;
}

type ContractThing = {
  address?: string;
  payload?: unknown;
};

const SURFACE_RECIPE_ADDRESS = 'package::investment-command::surface-recipe::trading-center';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readOwnerRef(value: unknown): InvestmentCommandOwnerRef | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  const label = readString(value.label);
  if (!id || !label) return null;
  return {
    id,
    label,
    status: readString(value.status, 'waiting'),
    role: readString(value.role),
    surfaceRef: readString(value.surfaceRef) || undefined,
  };
}

function readActionRecipe(value: unknown): InvestmentCommandActionRecipe {
  const record = isRecord(value) ? value : {};
  return {
    label: readString(record.label, 'Run paper order'),
    target: readString(record.target, 'slot::workflow'),
    definitionId: readString(record.definitionId, 'action:autonomous-paper-trading-cycle'),
    includeSteps: readBoolean(record.includeSteps, true),
    includeOutput: readBoolean(record.includeOutput, true),
    input: isRecord(record.input) ? record.input : {},
  };
}

function readSetupSurface(value: unknown): InvestmentCommandSurfaceRecipe['setupSurface'] {
  const record = isRecord(value) ? value : {};
  const packageEntry = isRecord(record.packageEntry) ? record.packageEntry : {};
  return {
    id: readString(record.id, 'service-connections.settings'),
    title: readString(record.title, 'Outside Accounts and Keys'),
    materialTarget: readString(record.materialTarget, 'service-connections'),
    packageEntry: {
      packageName: readString(packageEntry.packageName, 'service-connections'),
      entryName: readString(packageEntry.entryName, 'service-connections'),
    },
  };
}

function findSurfaceRecipePayload(): unknown {
  const things = Array.isArray(investmentCommandContract.things)
    ? investmentCommandContract.things as ContractThing[]
    : [];
  return things.find((thing) => thing.address === SURFACE_RECIPE_ADDRESS)?.payload;
}

export function decodeInvestmentCommandSurfaceRecipe(
  value: unknown = findSurfaceRecipePayload(),
): InvestmentCommandSurfaceRecipe {
  const record = isRecord(value) ? value : {};
  const ownerRefs = Array.isArray(record.ownerRefs)
    ? record.ownerRefs.map(readOwnerRef).filter((owner): owner is InvestmentCommandOwnerRef => !!owner)
    : [];

  return {
    kind: readString(record.kind, 'investment-command.surface-recipe'),
    title: readString(record.title, 'Trading Center'),
    eyebrow: readString(record.eyebrow, 'Live trading cockpit'),
    emptyTitle: readString(record.emptyTitle, 'Connect market data'),
    emptyCopy: readString(record.emptyCopy, 'Connect market data. No fake candles appear here.'),
    liveTitle: readString(record.liveTitle, 'Market price'),
    setupLabel: readString(record.setupLabel, 'Connect market data'),
    marketBarsInput: readString(record.marketBarsInput, 'market-bars'),
    setupSurface: readSetupSurface(record.setupSurface),
    primaryAction: readActionRecipe(record.primaryAction),
    ownerRefs,
  };
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
  const numeric = readNumber(record, ['timestamp', 'time', 't']);
  if (numeric !== null) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  const raw = readString(record.at) || readString(record.date);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function decodeMarketBar(value: unknown): InvestmentMarketBar | null {
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
    symbol: readString(value.symbol) || undefined,
  };
}

export function decodeInvestmentMarketBars(raw: unknown): InvestmentMarketBar[] {
  const rows = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.bars)
      ? raw.bars
      : [];

  return rows
    .map(decodeMarketBar)
    .filter((bar): bar is InvestmentMarketBar => !!bar)
    .sort((left, right) => left.timestamp - right.timestamp);
}

export function summarizeInvestmentMarketBars(
  bars: readonly InvestmentMarketBar[],
): InvestmentMarketSummary {
  if (bars.length === 0) {
    return { total: 0, average: 0, min: 0, max: 0, count: 0, latest: null, symbol: null };
  }
  const closes = bars.map((bar) => bar.close);
  const total = closes.reduce((sum, value) => sum + value, 0);
  const latest = bars[bars.length - 1]!;
  return {
    total,
    average: total / bars.length,
    min: Math.min(...bars.map((bar) => bar.low)),
    max: Math.max(...bars.map((bar) => bar.high)),
    count: bars.reduce((sum, bar) => sum + (bar.volume ?? 1), 0),
    latest: latest.close,
    symbol: latest.symbol ?? null,
  };
}

export const investmentCommandSurface = decodeInvestmentCommandSurfaceRecipe();
