// tools/traffic-attribution/read-data/browser-traffic-visit.ts
//
// Generic browser → TrafficSignalVisit capture. The signals a visit carries come
// from the two universal browser truths (Physics, not Society): the page URL's
// query string (utm_* + any custom param) and the referrer. The observer id is a
// sticky token persisted in storage so the same browser is one observer across
// visits (first-touch attribution). NO project name, NO source/medium literal as a
// branch — `source` is derived from utm_source or the referrer host, falling back
// to "direct". Pure: every effect (location, referrer, storage, id generator) is an
// injected value, so this is fully unit-testable with zero globals.

import type { TrafficSignalVisit } from './traffic-signals-rollup.ts';
import { clickIdsToAdd } from './click-ids.ts';

/** The sticky-observer storage key (one per project so projects don't share ids). */
export function observerStorageKey(projectId: string): string {
  return `bf.traffic.observer.${projectId}`;
}

// Capture is GENERIC over signal keys (no closed list): EVERY query-string param is
// recorded with its name as the signal key, so a new tracking param (utm_id, msclkid,
// twclid, li_fat_id, a custom `partner` param — ad platforms add these constantly)
// flows with ZERO code change. Which signals the board DISPLAYS is DATA (the tracked-
// project `dimensions` rows). Guards below bound abuse (key/value length + count) —
// they are size limits, not an allow-list, so the key set stays open.
// Exported as the SSOT signal bounds so EVERY capture transport applies the SAME
// abuse caps — the browser path here AND the open-internet /ingest POST path
// (observe-traffic.ts extractIngestBody). The more-dangerous open POST surface must
// never be LESS bounded than the browser. Size limits, not an allow-list (key set stays open).
export const MAX_SIGNAL_KEY_LEN = 64;
export const MAX_SIGNAL_VALUE_LEN = 256;
export const MAX_SIGNALS = 32;

// A page can be (re)presented by the engine WITHOUT a user navigating to it — the
// engine re-mounts the same page and injects a reload-nonce param to bust caches. That
// is NOT a visit (Physics: an engine re-present is not a user navigation), so capturing
// it would mint a phantom first-touch observer on every reload. These marker keys flag
// such a load. The default is the platform's own re-present param (a fixed engine
// mechanism, not a user-extensible Society enum — like a protocol bit); the capture-
// config DATA may EXTEND this list (reloadMarkerKeys) for any other non-navigation marker.
export const PLATFORM_PRESENTATION_RELOAD_MARKERS: readonly string[] = [
  'bitfield_presentation_reload_nonce',
];

/**
 * True when the query string carries any non-navigation reload marker — i.e. the page
 * was re-presented by the engine, not navigated to by a user. The beacon skips capture
 * for these so engine reloads never inflate the visit/observer count. Generic over the
 * marker set: presence of ANY key in `markerKeys` (DATA-extensible) is the only signal.
 */
export function isNonNavigationReload(
  search: string,
  markerKeys: readonly string[] = PLATFORM_PRESENTATION_RELOAD_MARKERS,
): boolean {
  if (!markerKeys || markerKeys.length === 0) return false;
  let params: URLSearchParams | null = null;
  try {
    params = new URLSearchParams(search || '');
  } catch {
    return false;
  }
  for (const key of markerKeys) {
    if (key && params.has(key)) return true;
  }
  return false;
}

/**
 * Normalize an injected timestamp to a canonical UTC ISO string, or "" if it is missing/
 * unparseable. The caller passes a real-world event time (the visit clock); parsing it here
 * keeps the builder testable (a fixed string in, a fixed bucket out — no ambient clock).
 */
function safeIsoUtc(now: string | undefined): string {
  if (typeof now !== 'string' || now.trim().length === 0) return '';
  const ms = Date.parse(now);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toISOString();
}

/** Reduce a referrer URL to a host token (e.g. "https://t.co/x" → "t.co"). */
export function referrerHost(referrer: string | null | undefined): string {
  if (!referrer || typeof referrer !== 'string') return '';
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '').trim();
    return host;
  } catch {
    return '';
  }
}

/** Inputs the capture needs — all injected so the builder stays pure/testable. */
export interface BrowserVisitInputs {
  /** The page URL's query string, e.g. window.location.search ("?utm_source=x"). */
  search: string;
  /** document.referrer (may be ""). */
  referrer: string;
  /** The page's own hostname, to ignore same-site referrers. */
  selfHost?: string;
  /** Read a persisted value (e.g. localStorage.getItem). */
  getStored: (key: string) => string | null;
  /** Persist a value (e.g. localStorage.setItem). */
  setStored: (key: string, value: string) => void;
  /** Generate a NEW observer id when none is stored. Must yield an address-safe token. */
  generateObserverId: () => string;
  /**
   * The visit timestamp as an ISO 8601 string (injected so the builder stays pure/clock-free).
   * When present + valid, the visit gains reserved `visit_date` (YYYY-MM-DD) + `visit_month`
   * (YYYY-MM) signals → the board breaks traffic/revenue down OVER TIME via the existing
   * emergent dimension switcher (zero new projection code). Absent/malformed → no time signals.
   */
  now?: string;
  /**
   * Read one of the page's cookies (e.g. from document.cookie). Ad platforms keep a click or browser id in a cookie
   * (ad-return.json `cookie_click_ids`); it joins the first-touch signals so a later sign-up or payment can be sent
   * back to that platform. Absent → only the click ids in the address are kept.
   */
  getCookie?: (name: string) => string | null | undefined;
}

/** Reserved derived signal keys the builder sets itself — a URL param of the same name is ignored. */
const RESERVED_SIGNAL_KEYS: readonly string[] = ['source', 'referrer', 'visit_date', 'visit_month'];

/** A browser visit + whether THIS browser was seen for the first time (first touch). */
export type BrowserVisit = TrafficSignalVisit & {
  /**
   * true the FIRST time this browser is seen for this project (no sticky id yet),
   * false on every return visit. The beacon writes the first-touch fact ONLY when
   * firstTouch is true, so a later visit from a different source can never overwrite
   * the observer's original source — this is unique-visitor FIRST-TOUCH attribution,
   * not last-touch. (Conversions are recorded as their own separate fact, so gating
   * the first-touch write on firstTouch does not drop later conversions.)
   */
  firstTouch: boolean;
};

/** A returning navigation is worth retaining when it carries a campaign tag. */
export function hasTrackedCampaignSignals(signals: Record<string, string>): boolean {
  return Object.entries(signals).some(([key, value]) => key.startsWith('utm_') && value.trim().length > 0);
}

/**
 * Build the BrowserVisit for the current browser visit, persisting a sticky observer
 * id. Returns the visit (always has an observerId; signals may include source/
 * referrer/utm_*) plus firstTouch. The caller passes the visit to
 * buildTrafficObserverFactWrite and uses firstTouch to write first-touch ONCE.
 */
export function browserTrafficVisit(projectId: string, io: BrowserVisitInputs): BrowserVisit {
  const signals: Record<string, string> = {};

  // 1. Query-string signals — EVERY param, keyed by its own name (open key set, no
  //    closed allow-list). Guarded by size/count so a hostile URL can't bloat a fact.
  let params: URLSearchParams | null = null;
  try {
    params = new URLSearchParams(io.search || '');
  } catch {
    params = null;
  }
  if (params) {
    for (const [rawKey, rawVal] of params.entries()) {
      if (Object.keys(signals).length >= MAX_SIGNALS) break;
      const key = (rawKey || '').trim();
      const val = (rawVal || '').trim();
      if (!key || key.length > MAX_SIGNAL_KEY_LEN) continue;
      if (!val || val.length > MAX_SIGNAL_VALUE_LEN) continue;
      if (RESERVED_SIGNAL_KEYS.includes(key)) continue; // reserved derived keys (set below)
      signals[key] = val;
    }
  }

  // 2. Referrer host (only if cross-site).
  const host = referrerHost(io.referrer);
  const selfHost = (io.selfHost || '').replace(/^www\./, '').trim();
  if (host && host !== selfHost) signals.referrer = host;

  // 3. `source` = utm_source, else referrer host, else "direct" (the universal
  //    fallback). One canonical first-touch source dimension for the board.
  signals.source = signals.utm_source || signals.referrer || 'direct';

  // 3b. Time signals from the injected visit timestamp (reserved keys). These let the board
  //     break traffic/revenue down OVER TIME via the existing dimension switcher — a daily
  //     `visit_date` and a monthly `visit_month` bucket. A valid ISO date yields both; an
  //     absent/malformed `now` yields neither (no fabricated time). YYYY-MM-DD / YYYY-MM are
  //     pure prefixes of the canonical ISO string, so this needs no clock and no locale.
  const iso = safeIsoUtc(io.now);
  if (iso) {
    signals.visit_date = iso.slice(0, 10); // YYYY-MM-DD
    signals.visit_month = iso.slice(0, 7); // YYYY-MM
  }

  // 3c. Ad click ids the page keeps in cookies, and ones made from a click id in the address (ad-return.json), under
  //     the same size limits as every other signal. The address's own click ids (gclid, fbclid...) came in at step 1.
  const ms = iso ? Date.parse(iso) : undefined;
  for (const [key, value] of Object.entries(clickIdsToAdd(signals, { getCookie: io.getCookie, atMs: ms }))) {
    if (Object.keys(signals).length >= MAX_SIGNALS) break;
    if (key.length > MAX_SIGNAL_KEY_LEN || value.length > MAX_SIGNAL_VALUE_LEN) continue;
    signals[key] = value;
  }

  // 4. Sticky observer id (first-touch identity for this browser+project). firstTouch
  //    is true only when there was no stored id before this call (a brand-new browser).
  const storageKey = observerStorageKey(projectId);
  const stored = io.getStored(storageKey);
  const firstTouch = !stored || stored.trim().length === 0;
  let observerId = stored;
  if (firstTouch) {
    observerId = io.generateObserverId();
    try {
      io.setStored(storageKey, observerId);
    } catch {
      /* storage may be unavailable (private mode) — visit still records this session */
    }
  }

  return { observerId: (observerId || '').trim(), signals, firstTouch };
}
