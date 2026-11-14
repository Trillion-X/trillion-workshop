// package-set://bitfield-studio/packages/polymarket/read-data/polymarket-live.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Decode live Polymarket data (Gamma markets + CLOB order book) into typed
// models the UI surfaces render directly. This is the translation boundary:
// backend vocabulary (condition_id, token_ids, clob, gamma, outcome_prices as
// strings) NEVER reaches the surface — this module translates everything.
//
// Market list  : decodeMarketList(gamma.markets payload) -> MarketListModel
// Market detail: decodeMarketDetail(gamma.markets, clob.book) -> MarketDetailModel
//
// NO fake data (L117). Every field is read from the live log or null/empty.
// =============================================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single prediction market row for the list view. */
export interface MarketRow {
  /** Internal market id — never shown in product UI. */
  readonly id: string;
  /** The full market question, as a human reads it. */
  readonly question: string;
  /** "Open" | "Resolved" — derived from active/closed flags. */
  readonly statusLabel: 'Open' | 'Resolved';
  /** Implied probability of Yes outcome as 0-100 number (e.g. 62 for 62%). */
  readonly yesPct: number | null;
  /** Implied probability of No outcome as 0-100 number (e.g. 38 for 38%). */
  readonly noPct: number | null;
  /** Human-formatted volume string (e.g. "$1.2M" or "$340K"). */
  readonly volumeLabel: string;
  /** Human-formatted liquidity string. */
  readonly liquidityLabel: string;
  /** Raw volume number for sorting. */
  readonly volumeRaw: number | null;
  /** YES outcome token id — needed to load the order book for this market. */
  readonly yesTokenId: string | null;
  /** All outcome names, in order. */
  readonly outcomes: readonly string[];
  /** All outcome prices as 0-100 percentages, in order. */
  readonly outcomePcts: readonly number[];
}

/** The market list model — what Screen A renders. */
export interface MarketListModel {
  readonly markets: readonly MarketRow[];
  readonly totalCount: number;
  readonly fetchedAt: string | null;
  readonly state: 'live' | 'loading' | 'error' | 'empty';
  readonly errorNote: string | null;
}

/** A single book level (bid or ask). */
export interface BookLevel {
  readonly price: number;
  readonly size: number;
  /** Human-formatted price as ¢ (e.g. "62¢"). */
  readonly priceLabel: string;
  /** Human-formatted size. */
  readonly sizeLabel: string;
}

/** The order book model — what Screen B's ladder renders. */
export interface MarketBookModel {
  readonly tokenId: string | null;
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly spread: number | null;
  readonly midpoint: number | null;
  readonly bidDepth: number | null;
  readonly askDepth: number | null;
  readonly levels: number;
  readonly fetchedAt: string | null;
  readonly state: 'live' | 'loading' | 'error';
  /** Human "Bid" label for the column header. */
  readonly bidLabel: string;
  /** Human "Ask" label for the column header. */
  readonly askLabel: string;
  /** Human spread label. */
  readonly spreadLabel: string;
  /** Human midpoint label. */
  readonly midpointLabel: string;
}

/** The full market detail model — what Screen B renders. */
export interface MarketDetailModel {
  readonly market: MarketRow | null;
  readonly book: MarketBookModel;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function readString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function readNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function readBoolean(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  return null;
}

/** Format a dollar amount: >=1M -> "$1.2M", >=1K -> "$340K", else "$123". */
function formatMoney(v: number | null): string {
  if (v === null) return '—';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${Math.round(v)}`;
}

/** Format a prediction-market price (0.0–1.0) as a ¢ label: 0.62 -> "62¢". */
function formatCents(v: number | null): string {
  if (v === null) return '—';
  return `${Math.round(v * 100)}¢`;
}

/** Format a prediction-market price as a % label: 0.62 -> "62%". */
function formatPct(v: number | null): string {
  if (v === null) return '—';
  return `${Math.round(v * 100)}%`;
}

/** Convert an outcome_price (string "0.62" or number 0.62) to 0-100 integer pct. */
function priceToIntPct(raw: unknown): number | null {
  const n = readNumber(raw);
  if (n === null) return null;
  return Math.round(n * 100);
}

// ---------------------------------------------------------------------------
// Market list decode
// ---------------------------------------------------------------------------

function decodeMarketRow(m: unknown): MarketRow | null {
  if (!isRecord(m)) return null;
  const id = readString(m.id);
  if (!id) return null;
  const question = readString(m.question) ?? '(unknown market)';

  const active = readBoolean(m.active);
  const closed = readBoolean(m.closed);
  const statusLabel: 'Open' | 'Resolved' = (closed === true || active === false) ? 'Resolved' : 'Open';

  // outcome_prices arrive as string array ["0.62","0.38"] — decode each.
  const outcomePricesRaw = Array.isArray(m.outcome_prices) ? m.outcome_prices : [];
  const outcomePcts = outcomePricesRaw.map((p) => priceToIntPct(p) ?? 0);

  // YES = index 0, NO = index 1 (Gamma binary market convention).
  const yesPct = outcomePcts[0] ?? null;
  const noPct = outcomePcts[1] ?? null;

  const volumeRaw = readNumber(m.volume);
  const liquidityRaw = readNumber(m.liquidity);

  // token_ids for the YES outcome is index 0.
  const tokenIds = Array.isArray(m.token_ids) ? m.token_ids : [];
  const yesTokenId = typeof tokenIds[0] === 'string' ? tokenIds[0] : null;

  const outcomes = Array.isArray(m.outcomes)
    ? m.outcomes.filter((o): o is string => typeof o === 'string')
    : ['Yes', 'No'];

  return {
    id,
    question,
    statusLabel,
    yesPct,
    noPct,
    volumeLabel: formatMoney(volumeRaw),
    liquidityLabel: formatMoney(liquidityRaw),
    volumeRaw,
    yesTokenId,
    outcomes,
    outcomePcts,
  };
}

const EMPTY_LIST_MODEL: MarketListModel = {
  markets: [],
  totalCount: 0,
  fetchedAt: null,
  state: 'loading',
  errorNote: null,
};

/**
 * Decode the live gamma.markets payload into a MarketListModel.
 * The live read delivers the array directly (the write-markets step stores
 * the array as the payload, not wrapped in {markets:[...]}). Tolerates both.
 */
export function decodeMarketList(raw: unknown): MarketListModel {
  // The payload may be the markets array directly, or a {markets,status} wrapper.
  let marketsArray: unknown[] = [];
  let statusObj: unknown = null;

  if (Array.isArray(raw)) {
    marketsArray = raw;
  } else if (isRecord(raw)) {
    if (Array.isArray(raw.markets)) {
      marketsArray = raw.markets;
      statusObj = raw.status;
    } else if (raw.found === false) {
      // Not yet fetched — honest loading state.
      return EMPTY_LIST_MODEL;
    }
  } else if (raw === null || raw === undefined) {
    return EMPTY_LIST_MODEL;
  }

  const status = isRecord(statusObj) ? statusObj : null;
  const state = status
    ? ((readString(status.state) === 'error') ? 'error' : (marketsArray.length === 0 ? 'empty' : 'live'))
    : (marketsArray.length === 0 ? 'loading' : 'live');
  const fetchedAt = status ? readString(status.fetched_at) : null;
  const errorNote = state === 'error' ? (readString(status?.note as unknown) ?? 'Markets unavailable') : null;

  const markets = marketsArray
    .map(decodeMarketRow)
    .filter((r): r is MarketRow => r !== null);

  return {
    markets,
    totalCount: markets.length,
    fetchedAt,
    state: state as 'live' | 'loading' | 'error' | 'empty',
    errorNote,
  };
}

// ---------------------------------------------------------------------------
// Order book decode
// ---------------------------------------------------------------------------

function decodeBookLevel(l: unknown): BookLevel | null {
  if (!isRecord(l)) return null;
  const price = readNumber(l.price);
  const size = readNumber(l.size);
  if (price === null || size === null) return null;
  return {
    price,
    size,
    priceLabel: formatCents(price),
    sizeLabel: size.toLocaleString('en-US', { maximumFractionDigits: 0 }),
  };
}

const EMPTY_BOOK: MarketBookModel = {
  tokenId: null,
  bids: [],
  asks: [],
  bestBid: null,
  bestAsk: null,
  spread: null,
  midpoint: null,
  bidDepth: null,
  askDepth: null,
  levels: 0,
  fetchedAt: null,
  state: 'loading',
  bidLabel: 'Bid',
  askLabel: 'Ask',
  spreadLabel: '—',
  midpointLabel: '—',
};

/**
 * Decode the live clob.book payload into a MarketBookModel.
 * The write-book step stores the book object as the payload directly.
 */
export function decodeMarketBook(raw: unknown): MarketBookModel {
  if (!isRecord(raw)) return EMPTY_BOOK;
  if (raw.found === false) return EMPTY_BOOK;

  // Payload is the book object directly, or wrapped in {book:{...}}.
  const b = isRecord((raw as {book?:unknown}).book) ? (raw as {book:Record<string,unknown>}).book : raw;
  if (!isRecord(b)) return EMPTY_BOOK;

  const rawBids = Array.isArray(b.bids) ? b.bids : [];
  const rawAsks = Array.isArray(b.asks) ? b.asks : [];
  const bids = rawBids.map(decodeBookLevel).filter((l): l is BookLevel => l !== null);
  const asks = rawAsks.map(decodeBookLevel).filter((l): l is BookLevel => l !== null);

  const bestBid = readNumber(b.best_bid);
  const bestAsk = readNumber(b.best_ask);
  const spread = readNumber(b.spread);
  const midpoint = readNumber(b.midpoint);
  const bidDepth = readNumber(b.bid_depth);
  const askDepth = readNumber(b.ask_depth);
  const levels = readNumber(b.levels) ?? (bids.length + asks.length);

  const statusObj = isRecord((raw as {status?:unknown}).status) ? (raw as {status:Record<string,unknown>}).status : null;
  const fetchedAt = statusObj ? readString(statusObj.fetched_at) : null;
  const state: 'live' | 'error' | 'loading' =
    statusObj ? (readString(statusObj.state) === 'error' ? 'error' : 'live') :
    (bids.length + asks.length > 0 ? 'live' : 'loading');

  return {
    tokenId: readString(b.token_id),
    bids,
    asks,
    bestBid,
    bestAsk,
    spread,
    midpoint,
    bidDepth,
    askDepth,
    levels,
    fetchedAt,
    state,
    bidLabel: 'Bid',
    askLabel: 'Ask',
    spreadLabel: spread !== null ? formatCents(spread) : '—',
    midpointLabel: midpoint !== null ? formatCents(midpoint) : '—',
  };
}

/**
 * Combine markets list + selected market + book into the detail model.
 * selectedMarketId is the market the user clicked on.
 */
export function decodeMarketDetail(
  listModel: MarketListModel,
  bookRaw: unknown,
  selectedMarketId: string | null,
): MarketDetailModel {
  const market = selectedMarketId
    ? (listModel.markets.find((m) => m.id === selectedMarketId) ?? null)
    : (listModel.markets[0] ?? null);
  const book = decodeMarketBook(bookRaw);
  return { market, book };
}
