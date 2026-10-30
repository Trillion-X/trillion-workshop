// tools/traffic-attribution/do-work/observe-traffic.ts
//
// FUNNEL-USABLE append-only traffic capture. The funnel runs as package code, whose
// ONLY runtime surface is write (sendRequestToBitfieldTarget) + declared-input reads
// (useBitfieldData) — it CANNOT do the rollup's read-modify-write (no arbitrary
// read-current). So capture is append-only: each observer writes ONE fact at ITS OWN
// address `traffic::<projectId>::observer::<observerId>` (idempotent, last-write-wins,
// no read, no CAS, no clobber) — the SAME proven model as recordViewObservation. The
// rollup/projection then DERIVE from these facts via a fold (record_from_matching_
// records → flat list) + client-side group-by-projectId in the board.
//
// One batch writes BOTH the observer fact AND the tracked-project auto-register row
// (both write-only) so a project appears the instant it has traffic (L083 default).
//
// Pure builder: no I/O. The funnel does `sendRequestToBitfieldTarget(build(...))` in
// a post-paint effect. Project identity is a DATA arg — zero project name in code.

import {
  trafficObserverFactAddress,
  trafficReturnVisitAddress,
  trafficConversionAddress,
  isValidProjectId,
} from '../read-data/traffic-address.ts';
import {
  MAX_SIGNALS,
  MAX_SIGNAL_KEY_LEN,
  MAX_SIGNAL_VALUE_LEN,
} from '../read-data/browser-traffic-visit.ts';
import type { TrafficSignalVisit } from '../read-data/traffic-signals-rollup.ts';
import { mapFactFields } from '../read-data/map-fact-fields.ts';

// Upper bound on a conversion's monetary value, applied on the open-internet /ingest
// path so a forged POST cannot inject an absurd revenue figure that poisons ROAS.
// A size sanity cap (not a business rule) — any legitimate sale is far below this.
const MAX_CONVERSION_VALUE = 1_000_000_000; // 1e9

/** The kind every append-only observer traffic fact carries, so the fold collects them. */
export const TRAFFIC_OBSERVER_FACT_KIND = 'traffic-observer-fact';

/** The kind every append-only CONVERSION fact carries (its own fold). */
export const TRAFFIC_CONVERSION_KIND = 'traffic-conversion';

const ENGINE_OPERATION_LABEL_TARGET = 'engine.operation.label-addressed';
const ENGINE_WRITE_BATCH_OPERATION = 'engine.operation.write-batch';
const PUBLISHED_RECORD_PATH = ['current-item', 'published-record'] as const;

/** One observer's traffic fact — the same shape as a rollup row (the fold's rows). */
export interface TrafficObserverFact {
  kind: typeof TRAFFIC_OBSERVER_FACT_KIND;
  projectId: string;
  observer_id: string;
  signals: Record<string, string>;
  converted?: boolean;
  touch?: 'return';
  visit_id?: string;
}

/**
 * Build the append-only write for one observer's visit: ONLY the observer fact (its own
 * address). Returns null for an invalid projectId/observer or a blank visit (nothing to
 * record). Write-only — the funnel sends it with sendRequestToBitfieldTarget; no read, no CAS.
 *
 * SSOT (do NOT re-add a tracked-project write here): the capture writer must NEVER write the
 * `traffic::tracked-project::<id>` record. That record is OPERATOR CONFIG (currency, outcomes,
 * dimensions) owned by the single writer `track-project` (the "Add a project" form). An
 * earlier version auto-registered a DEFAULTS record on every visit, which OVERWROTE the
 * operator's config at the same address — silently wiping currency/outcomes on the first (and
 * every) visit. The fix is structural (L063): the config address has exactly one writer, so
 * clobbering is impossible. A project that has traffic but no config still appears in the board
 * — the surface UNIONS configured projects with projectIds present in the observer-fact fold
 * (defaulted), so "projects auto-appear when they send traffic" holds with zero clobber.
 */
export function buildTrafficObserverFactWrite(projectId: string, visit: TrafficSignalVisit) {
  if (!isValidProjectId(projectId)) return null;
  if (!visit || typeof visit.observerId !== 'string' || visit.observerId.trim().length === 0) return null;
  if (!isValidProjectId(visit.observerId)) return null; // observer id must be address-safe
  const signals: Record<string, string> = {};
  for (const [k, v] of Object.entries(visit.signals ?? {})) {
    if (typeof v === 'string' && v.trim().length > 0) signals[k] = v.trim();
  }
  const converted = visit.converted === true;
  if (Object.keys(signals).length === 0 && !converted) return null;

  const observerId = visit.observerId.trim();
  const fact: TrafficObserverFact = {
    kind: TRAFFIC_OBSERVER_FACT_KIND,
    projectId: projectId.trim(),
    observer_id: observerId,
    signals,
    ...(converted ? { converted: true } : {}),
  };
  const writes: Array<Record<string, unknown>> = [
    {
      address_label: trafficObserverFactAddress(projectId, observerId),
      path_labels: [...PUBLISHED_RECORD_PATH],
      payload: fact,
    },
  ];
  return {
    target: ENGINE_OPERATION_LABEL_TARGET,
    payload: { operation_label: ENGINE_WRITE_BATCH_OPERATION, writes },
  };
}

/** Keep one later campaign navigation without changing its immutable first touch. */
export function buildTrafficReturnVisitWrite(
  projectId: string,
  visit: { observerId: string; visitId: string; signals: Record<string, string> },
) {
  if (!isValidProjectId(projectId) || !isValidProjectId(visit?.observerId) || !isValidProjectId(visit?.visitId)) return null;
  const signals: Record<string, string> = {};
  for (const [key, raw] of Object.entries(visit.signals ?? {})) {
    if (Object.keys(signals).length >= MAX_SIGNALS) break;
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (key.length > MAX_SIGNAL_KEY_LEN || !value || value.length > MAX_SIGNAL_VALUE_LEN) continue;
    signals[key] = value;
  }
  if (!Object.entries(signals).some(([key, value]) => key.startsWith('utm_') && value)) return null;
  const fact: TrafficObserverFact = {
    kind: TRAFFIC_OBSERVER_FACT_KIND,
    projectId: projectId.trim(), observer_id: visit.observerId.trim(),
    touch: 'return', visit_id: visit.visitId.trim(), signals,
  };
  return {
    target: ENGINE_OPERATION_LABEL_TARGET,
    payload: {
      operation_label: ENGINE_WRITE_BATCH_OPERATION,
      writes: [{
        address_label: trafficReturnVisitAddress(projectId, visit.observerId, visit.visitId),
        path_labels: [...PUBLISHED_RECORD_PATH], payload: fact,
      }],
    },
  };
}

/** One observer's conversion fact (its own append-only record at the conversion address). */
export interface TrafficConversionFact {
  kind: typeof TRAFFIC_CONVERSION_KIND;
  projectId: string;
  observer_id: string;
  /** which conversion metric fired (DATA, e.g. "purchase") — optional; board uses its own metric. */
  metric?: string;
  /** the conversion's monetary VALUE/amount (DATA) — optional; drives revenue-per-source (ROAS). */
  value?: number;
}

/**
 * Build the append-only CONVERSION write for one observer: a fact at the conversion
 * address (NOT an overwrite of the first-touch fact). Write-only, funnel-usable. The
 * conversion metric is DATA (which outcome fired); null projectId/observer → null.
 */
export function buildTrafficConversionWrite(projectId: string, observerId: string, metric?: string, value?: number) {
  if (!isValidProjectId(projectId) || !isValidProjectId(observerId)) return null;
  const cleanValue = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  const fact: TrafficConversionFact = {
    kind: TRAFFIC_CONVERSION_KIND,
    projectId: projectId.trim(),
    observer_id: observerId.trim(),
    ...(typeof metric === 'string' && metric.trim() ? { metric: metric.trim() } : {}),
    ...(cleanValue !== undefined ? { value: cleanValue } : {}),
  };
  return {
    target: ENGINE_OPERATION_LABEL_TARGET,
    payload: {
      operation_label: ENGINE_WRITE_BATCH_OPERATION,
      writes: [
        {
          // per-outcome address so one observer can durably record MULTIPLE outcomes (lead AND purchase)
          address_label: trafficConversionAddress(projectId, observerId, metric),
          path_labels: [...PUBLISHED_RECORD_PATH],
          payload: fact,
        },
      ],
    },
  };
}

// =============================================================================
// INGEST TRANSFORM (the source-specific half of the generic /ingest/:connectionId
// route — see _shared/plans/.../T3-INGEST-ROUTE-SPEC.md). The generic shell route
// resolves a service-connections connection, auths via credentials-vault, then hands
// the raw inbound body to the connection's `transformRef` target and expects back
// `{ writes: [...] }` (write-batch entries) which it writes to the connection's
// targetPartition. This is the TRAFFIC transform: it turns an inbound visit into the
// SAME append-only observer-fact writes the in-app beacon produces (SSOT —
// buildTrafficObserverFactWrite), so a non-Bitfield page lands identical facts. The
// transform owns ZERO project name — projectId comes from the inbound body (DATA).
// =============================================================================

/** What the transform target returns to the route: the write-batch entries to apply. */
export interface TrafficIngestTransformOutput {
  writes: Array<Record<string, unknown>>;
}

/**
 * Narrow an opaque inbound payload to the ingest body (full TrafficIngestRequest OR a bare body).
 * Carries `conversion` (this inbound is a CONVERSION, not a visit) + `metric` so the transform
 * can route to the right SSOT writer. A conversion body needs no signals (only the observer to
 * attribute the sale to); a visit body needs signals or a converted flag (handled downstream).
 */
function extractIngestBody(
  raw: unknown,
): {
  projectId: string;
  observerId: string;
  signals: Record<string, string>;
  converted?: boolean;
  visitId?: string;
  touch?: 'return';
  conversion?: boolean;
  metric?: string;
  value?: number;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  // Accept either the full request ({body:{...}}) or the bare body ({projectId,...}).
  const obj = raw as Record<string, unknown>;
  const candidate = (obj.body && typeof obj.body === 'object' ? obj.body : obj) as Record<string, unknown>;
  const projectId = candidate.projectId;
  const observerId = candidate.observerId;
  if (typeof projectId !== 'string' || projectId.trim().length === 0) return null;
  if (typeof observerId !== 'string' || observerId.trim().length === 0) return null;
  const signals: Record<string, string> = {};
  if (candidate.signals && typeof candidate.signals === 'object') {
    // Apply the SAME abuse caps as the browser capture path (SSOT bounds) — the open
    // /ingest POST surface must not be less bounded than the browser (DoS / fold-bloat).
    for (const [k, v] of Object.entries(candidate.signals as Record<string, unknown>)) {
      if (Object.keys(signals).length >= MAX_SIGNALS) break;
      if (typeof v !== 'string') continue;
      const key = (k || '').trim();
      const val = v.trim();
      if (!key || key.length > MAX_SIGNAL_KEY_LEN) continue;
      if (!val || val.length > MAX_SIGNAL_VALUE_LEN) continue;
      signals[key] = val;
    }
  }
  const converted = candidate.converted === true;
  const visitId = typeof candidate.visitId === 'string' && isValidProjectId(candidate.visitId) ? candidate.visitId.trim() : undefined;
  const touch = candidate.touch === 'return' ? 'return' : undefined;
  // A conversion inbound is self-describing: body.conversion === true (or the envelope's
  // event_type names it). Routing is by DATA, not by a hardcoded code path per project.
  const conversion = candidate.conversion === true || obj.event_type === TRAFFIC_CONVERSION_EVENT_TYPE;
  const metricRaw = candidate.metric;
  const metric = typeof metricRaw === 'string' && metricRaw.trim() ? metricRaw.trim() : undefined;
  const valueRaw = candidate.value;
  const value =
    typeof valueRaw === 'number' && Number.isFinite(valueRaw) && valueRaw > 0 && valueRaw <= MAX_CONVERSION_VALUE
      ? valueRaw
      : undefined;
  return {
    projectId: projectId.trim(),
    observerId: observerId.trim(),
    signals,
    ...(converted ? { converted: true } : {}),
    ...(visitId ? { visitId } : {}),
    ...(touch ? { touch } : {}),
    ...(conversion ? { conversion: true } : {}),
    ...(metric ? { metric } : {}),
    ...(value !== undefined ? { value } : {}),
  };
}

/**
 * The TRAFFIC ingest transform: opaque inbound body → `{ writes }` for the route to
 * apply. Reuses buildTrafficObserverFactWrite (SSOT) so an external-page visit lands
 * byte-identical facts to the in-app beacon. Returns `{ writes: [] }` for any invalid/
 * empty input (the route writes nothing — no partial/garbage facts). No project name.
 */
export function buildTrafficIngestTransformOutput(rawInbound: unknown): TrafficIngestTransformOutput {
  const body = extractIngestBody(rawInbound);
  if (!body) return { writes: [] };
  // Self-describing routing: a CONVERSION inbound writes a separate append-only conversion
  // fact (buildTrafficConversionWrite) — it must NOT overwrite the first-touch observer fact
  // (which carries the source attribution). A VISIT inbound writes the observer fact. Both
  // are the existing SSOT builders; the route is by the inbound's own DATA, no project names.
  if (body.touch === 'return' && !body.visitId) return { writes: [] };
  const req = body.conversion
    ? buildTrafficConversionWrite(body.projectId, body.observerId, body.metric, body.value)
    : body.touch === 'return'
    ? buildTrafficReturnVisitWrite(body.projectId, { observerId: body.observerId, visitId: body.visitId!, signals: body.signals })
    : buildTrafficObserverFactWrite(body.projectId, {
        observerId: body.observerId,
        signals: body.signals,
        converted: body.converted,
      });
  if (!req) return { writes: [] };
  const writes = (req.payload as { writes?: unknown }).writes;
  return { writes: Array.isArray(writes) ? (writes as Array<Record<string, unknown>>) : [] };
}

/**
 * SP9 output-contract: every emitted write MUST be a FACT scoped to the inbound project's
 * traffic address space (`traffic::<projectId>::…`). The run-a-job descriptor's validate step
 * calls this; a false result means the route must reject (fail-closed), so a compromised/
 * misconfigured transform can never write outside its project — NOR write the operator-config
 * record. The ingest path only ever lands append-only facts (observer/conversion), both of
 * which are `traffic::<projectId>::…`; it must NEVER write `traffic::tracked-project::<id>`
 * (that is operator config, single-writer = the "Add a project" form). So the scope is exactly
 * the project fact prefix — no tracked-project exception (removing it closes a config-injection
 * path that the now-deleted auto-register used to require).
 */
export function ingestWritesWithinProjectScope(
  output: TrafficIngestTransformOutput,
  projectId: string,
): boolean {
  if (!isValidProjectId(projectId)) return false;
  const prefix = `traffic::${projectId.trim()}::`;
  for (const w of output.writes) {
    const addr = (w as { address_label?: unknown }).address_label;
    if (typeof addr !== 'string') return false;
    if (!addr.startsWith(prefix)) return false;
  }
  return true;
}

/** The event_type the web snippet posts so a workflow trigger can route it. */
export const TRAFFIC_INGEST_EVENT_TYPE = 'traffic.visit';

/** The event_type a CONVERSION inbound posts — routes the transform to a conversion fact. */
export const TRAFFIC_CONVERSION_EVENT_TYPE = 'traffic.conversion';

/** The lean inbound-ingest request the web snippet POSTs to the network-ingest webhook. */
export interface TrafficIngestRequest {
  api_key: string;
  event_type: typeof TRAFFIC_INGEST_EVENT_TYPE;
  body: { projectId: string; observerId: string; signals: Record<string, string>; converted?: boolean; visitId?: string; touch?: 'return' };
  idempotency_key: string;
}

/**
 * Build the lean IngestRequest the web snippet POSTs to network-ingest's `/webhook/:id`
 * (for NON-Bitfield sites that can't use sendRequestToBitfieldTarget). The body is the
 * opaque traffic payload; a workflow-def turns it into the append-only fact server-side
 * (reusing buildTrafficObserverFactWrite) — the snippet never writes engine records
 * directly (security: the open internet only ever hits the scoped ingest route). Returns
 * null for an invalid project/observer or an empty visit. First touch uses
 * project:observer; a later tagged visit adds its unique visit ID.
 */
export function buildTrafficIngestRequest(
  projectId: string,
  visit: { observerId: string; signals?: Record<string, string>; converted?: boolean; visitId?: string; touch?: 'return' },
  apiKey: string,
): TrafficIngestRequest | null {
  if (!isValidProjectId(projectId)) return null;
  if (!visit || !isValidProjectId(visit.observerId)) return null;
  const signals: Record<string, string> = {};
  for (const [k, v] of Object.entries(visit.signals ?? {})) {
    if (typeof v === 'string' && v.trim().length > 0) signals[k] = v.trim();
  }
  const converted = visit.converted === true;
  if (Object.keys(signals).length === 0 && !converted) return null;
  const projectIdClean = projectId.trim();
  const observerId = visit.observerId.trim();
  const returnVisitId = visit.touch === 'return' && typeof visit.visitId === 'string' && isValidProjectId(visit.visitId)
    ? visit.visitId.trim() : undefined;
  if (visit.touch === 'return' && (!returnVisitId || !Object.entries(signals).some(([key, value]) => key.startsWith('utm_') && value))) return null;
  return {
    api_key: typeof apiKey === 'string' ? apiKey : '',
    event_type: TRAFFIC_INGEST_EVENT_TYPE,
    body: { projectId: projectIdClean, observerId, signals, ...(converted ? { converted: true } : {}), ...(returnVisitId ? { visitId: returnVisitId, touch: 'return' as const } : {}) },
    idempotency_key: `${projectIdClean}:${observerId}${returnVisitId ? `:visit:${returnVisitId}` : ''}`,
  };
}

/** A CONVERSION inbound the in-app conversion beacon POSTs to the unified console route. */
export interface TrafficIngestConversionRequest {
  api_key: string;
  event_type: typeof TRAFFIC_CONVERSION_EVENT_TYPE;
  body: { projectId: string; observerId: string; conversion: true; metric?: string; value?: number };
  idempotency_key: string;
}

/**
 * Build the CONVERSION inbound the in-app conversion beacon delivers to the console route
 * (the conversion twin of buildTrafficIngestRequest). The route's transform routes this —
 * via body.conversion / event_type — to buildTrafficConversionWrite, landing a SEPARATE
 * append-only conversion fact (never overwriting the first-touch source). Returns null for
 * an invalid project/observer. idempotency_key = project:observer:conversion so a re-fired
 * conversion beacon for the same observer is dispatched once (distinct from its visit key).
 */
export function buildTrafficIngestConversionRequest(
  projectId: string,
  observerId: string,
  metric: string | undefined,
  apiKey: string,
  value?: number,
): TrafficIngestConversionRequest | null {
  if (!isValidProjectId(projectId) || !isValidProjectId(observerId)) return null;
  const projectIdClean = projectId.trim();
  const observerIdClean = observerId.trim();
  const metricClean = typeof metric === 'string' && metric.trim() ? metric.trim() : undefined;
  const valueClean = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  return {
    api_key: typeof apiKey === 'string' ? apiKey : '',
    event_type: TRAFFIC_CONVERSION_EVENT_TYPE,
    body: { projectId: projectIdClean, observerId: observerIdClean, conversion: true, ...(metricClean ? { metric: metricClean } : {}), ...(valueClean !== undefined ? { value: valueClean } : {}) },
    idempotency_key: `${projectIdClean}:${observerIdClean}:conversion`,
  };
}

/**
 * Group flat observer-fact + (optional) conversion-fact lists (from the folds) into
 * per-project rollup aggregates `{ [projectId]: { kind:'traffic-signals', rows:[...] } }`.
 * Later visit facts are skipped here. Each observer is one row: signals from its first-touch fact, converted=true if it has
 * a conversion fact for the same project. The board runs this then deriveProjection over
 * the selected project's aggregate — all client-side (no per-project dynamic address read).
 */
export function groupObserverFactsByProject(
  list: unknown,
  conversions?: unknown,
): Record<string, { kind: 'traffic-signals'; rows: Array<{ observer_id: string; signals: Record<string, string>; converted?: boolean; outcomes?: string[]; value?: number }> }> {
  const out: Record<string, { kind: 'traffic-signals'; rows: Array<{ observer_id: string; signals: Record<string, string>; converted?: boolean; outcomes?: string[]; value?: number }> }> = {};

  // Conversions indexed by `projectId observer_id`: WHICH outcome metric(s) fired, whether a
  // metric-less ("default outcome") conversion fired, AND the accumulated monetary value (sum
  // of every conversion's amount for that observer). The board (deriveProjection) discriminates
  // by the project's configured conversionMetric so a `signup`/`lead` does NOT inflate the
  // `purchase` count, while a metric-less conversion still counts as the default outcome (L116);
  // value drives revenue-per-source (ROAS). `metric`/`value` are DATA - a new outcome adds zero code.
  const convByObserver = new Map<string, { metrics: Set<string>; hasDefault: boolean; value: number }>();
  const convList = Array.isArray(conversions) ? conversions : [];
  for (const raw of convList) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Partial<TrafficConversionFact>;
    if (c.kind !== TRAFFIC_CONVERSION_KIND) continue;
    if (typeof c.projectId !== 'string' || typeof c.observer_id !== 'string') continue;
    const key = `${c.projectId} ${c.observer_id}`;
    const entry = convByObserver.get(key) ?? { metrics: new Set<string>(), hasDefault: false, value: 0 };
    const metric = typeof c.metric === 'string' && c.metric.trim().length > 0 ? c.metric.trim() : '';
    if (metric) entry.metrics.add(metric);
    else entry.hasDefault = true;
    if (typeof c.value === 'number' && Number.isFinite(c.value) && c.value > 0) entry.value += c.value;
    convByObserver.set(key, entry);
  }

  const facts = Array.isArray(list) ? list : [];
  for (const raw of facts) {
    if (!raw || typeof raw !== 'object') continue;
    const f = raw as Partial<TrafficObserverFact>;
    if (f.kind !== TRAFFIC_OBSERVER_FACT_KIND) continue;
    if (f.touch === 'return') continue; // the board counts unique first-touch observers
    if (typeof f.projectId !== 'string' || typeof f.observer_id !== 'string') continue;
    const agg = out[f.projectId] ?? (out[f.projectId] = { kind: 'traffic-signals', rows: [] });
    const conv = convByObserver.get(`${f.projectId} ${f.observer_id}`);
    // `f.converted` is a legacy inline flag on the observer fact itself (metric-less) -> default.
    // `converted` here means a metric-less/DEFAULT conversion fired (counts toward the project's
    // default outcome, L116); explicit outcome metrics go in `outcomes` (one board column each).
    const hasDefault = f.converted === true || (conv?.hasDefault ?? false);
    const outcomes = conv ? Array.from(conv.metrics) : [];
    const value = conv && conv.value > 0 ? conv.value : 0;
    agg.rows.push({
      observer_id: f.observer_id,
      signals: (f.signals && typeof f.signals === 'object') ? f.signals as Record<string, string> : {},
      ...(hasDefault ? { converted: true } : {}),
      ...(outcomes.length > 0 ? { outcomes } : {}),
      ...(value > 0 ? { value } : {}),
    });
  }
  return out;
}

// =============================================================================
// OUTBOUND PIXEL / ANALYTICS MIRROR (DATA-driven, no provider enum). On capture, a
// visit can ALSO be mirrored to the operator's own analytics venues (GA4, Meta pixel,
// a webhook — anything). Each venue is a DATA row {url, fieldMap?, method?} in
// capture-config `outboundVenues`; the field mapping REUSES read-data/map-fact-fields.ts'
// mapFactFields (no re-owning the mirror primitive). No GA/Meta/provider literal lives
// here — a new tracker is a DATA row. The browser beacon fires these (a client pixel
// must fire from the browser); this builder is pure (no fetch) so it is fully testable.
// =============================================================================

/** One outbound analytics venue (DATA): where to mirror + how to map signal fields. */
export interface OutboundVenue {
  /** the venue endpoint (must be http(s); anything else is skipped, fail-closed). */
  url: string;
  /** optional targetKey ← signalKey map (GA4/Meta param naming); absent → whole signals object. */
  fieldMap?: Record<string, string>;
  /** GET (image-pixel, fields in query) or POST (JSON body). Defaults to GET. */
  method?: 'GET' | 'POST';
}

/** A ready-to-fire outbound request the beacon dispatches with fetch. */
export interface OutboundPixelRequest {
  url: string;
  method: 'GET' | 'POST';
  body?: string;
}

/**
 * Build the outbound mirror requests for one visit's signals across DATA venues. Reuses
 * mapFactFields (read-data/map-fact-fields.ts) to map each venue's field_map over the signals, then
 * adds the observer_id for attribution. GET → mapped fields in the query string (image
 * pixel); POST → JSON body. Non-http venues are skipped (fail-closed, no garbage fire).
 * Pure — no I/O, no clock; the browser beacon fires the returned requests.
 */
export function buildOutboundPixelRequests(
  signals: Record<string, string>,
  observerId: string,
  venues: OutboundVenue[] | undefined,
): OutboundPixelRequest[] {
  const list = Array.isArray(venues) ? venues : [];
  const out: OutboundPixelRequest[] = [];
  for (const v of list) {
    if (!v || typeof v.url !== 'string' || !/^https?:\/\//i.test(v.url.trim())) continue;
    const url = v.url.trim();
    const mapped = mapFactFields({ value: signals }, v.fieldMap);
    const event: Record<string, unknown> = { ...mapped, observer_id: observerId };
    const method: 'GET' | 'POST' = v.method === 'POST' ? 'POST' : 'GET';
    if (method === 'POST') {
      out.push({ url, method, body: JSON.stringify(event) });
    } else {
      const qs = new URLSearchParams();
      for (const [k, val] of Object.entries(event)) {
        if (val === null || val === undefined) continue;
        qs.set(k, typeof val === 'object' ? JSON.stringify(val) : String(val));
      }
      const sep = url.includes('?') ? '&' : '?';
      out.push({ url: `${url}${sep}${qs.toString()}`, method: 'GET' });
    }
  }
  return out;
}
