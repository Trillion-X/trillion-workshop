// tools/traffic-attribution/read-data/traffic-address.ts
//
// SSOT for traffic-attribution addresses. Project identity is a DATA key threaded
// through every stage (capture -> rollup -> projection -> board). NO project name
// is ever written in code — only passed as the `projectId` DATA value here. Every
// other module imports `trafficAddress`; nothing else concatenates `traffic::`.
//
// Address scheme:
//   traffic::tracked-project::<projectId>   registry row (one per tracked project)
//   traffic::tracked-project-list           enumerable list of registry rows (derived)
//   traffic::<projectId>::rollup            per-project TrafficSignalsAggregate (capture target)
//   traffic::<projectId>::projection        per-project {view,records} (board source)
//   traffic::selected-project               runtime state: which project the board shows
//
// Pure: no I/O, no clock, no React.

/** Address kinds. Project-scoped kinds REQUIRE a projectId; global kinds forbid it. */
export type TrafficAddressKind =
  | 'tracked-project'
  | 'tracked-project-list'
  | 'selected-project';

const PREFIX = 'traffic';

const PROJECT_SCOPED: Record<TrafficAddressKind, boolean> = {
  'tracked-project': true,
  'tracked-project-list': false,
  'selected-project': false,
};

function cleanProjectId(projectId: unknown): string {
  if (typeof projectId !== 'string') return '';
  const trimmed = projectId.trim();
  // project id is a DATA token: lowercase letters, digits, dot, underscore, dash.
  // Reject anything else so it cannot inject `::` address separators.
  return /^[a-z0-9._-]+$/i.test(trimmed) ? trimmed : '';
}

/** Whether a string is a valid project id token (safe to embed in an address). */
export function isValidProjectId(projectId: unknown): boolean {
  return cleanProjectId(projectId).length > 0;
}

/**
 * Per-observer traffic fact address: `traffic::<projectId>::observer::<observerId>`.
 * This is the FUNNEL-USABLE capture target — the funnel (package code) can only
 * WRITE (sendRequestToBitfieldTarget) and read declared inputs, so it cannot do the
 * rollup's read-modify-write. Instead each observer writes ONE fact at ITS OWN
 * address (append-only, idempotent, last-write-wins, no read, no CAS, no clobber) —
 * the SAME proven model as recordViewObservation. The rollup/projection then derive
 * from these facts via a fold. Throws on an invalid projectId or observerId so a bad
 * id can never inject `::` separators.
 */
export function trafficObserverFactAddress(projectId: string, observerId: string): string {
  const id = cleanProjectId(projectId);
  if (!id) throw new Error(`[traffic] observer fact requires a valid projectId (got ${JSON.stringify(projectId)})`);
  const obs = cleanProjectId(observerId); // same token charset — safe to embed
  if (!obs) throw new Error(`[traffic] observer fact requires a valid observerId (got ${JSON.stringify(observerId)})`);
  return `${PREFIX}::${id}::observer::${obs}`;
}

/** A distinct campaign visit by an existing observer; never shares the first-touch address. */
export function trafficReturnVisitAddress(projectId: string, observerId: string, visitId: string): string {
  const id = cleanProjectId(projectId);
  const obs = cleanProjectId(observerId);
  const visit = cleanProjectId(visitId);
  if (!id || !obs || !visit) throw new Error('[traffic] return visit requires valid project, observer and visit IDs');
  return `${PREFIX}::${id}::visit::${obs}::${visit}`;
}

/**
 * Per-observer-PER-OUTCOME CONVERSION fact address:
 *   `traffic::<projectId>::conversion::<observerId>` for a metric-less (default) conversion, or
 *   `traffic::<projectId>::conversion::<observerId>::<metric>` when an explicit outcome metric is given.
 * A conversion is its OWN append-only fact (NOT an overwrite of the first-touch fact). Giving each
 * OUTCOME its own address lets ONE observer durably record MULTIPLE distinct outcomes (lead AND
 * purchase — the funnel) without read-modify-write: two outcomes = two append-only records. The
 * board merges first-touch facts + every conversion fact per observer. Throws on invalid ids; an
 * address-unsafe metric falls back to the metric-less (default) address.
 */
export function trafficConversionAddress(projectId: string, observerId: string, metric?: string): string {
  const id = cleanProjectId(projectId);
  if (!id) throw new Error(`[traffic] conversion fact requires a valid projectId (got ${JSON.stringify(projectId)})`);
  const obs = cleanProjectId(observerId);
  if (!obs) throw new Error(`[traffic] conversion fact requires a valid observerId (got ${JSON.stringify(observerId)})`);
  const base = `${PREFIX}::${id}::conversion::${obs}`;
  const m = cleanProjectId(metric); // address-safe outcome segment, '' when absent/unsafe
  return m ? `${base}::${m}` : base;
}

/**
 * Build a traffic address for a kind, optionally scoped to a project.
 * Throws if a project-scoped kind is missing/has an invalid projectId, or a
 * global kind is given one — fail loud so a bad project id never silently lands
 * at the wrong address.
 */
export function trafficAddress(kind: TrafficAddressKind, projectId?: string): string {
  const scoped = PROJECT_SCOPED[kind];
  if (scoped === undefined) throw new Error(`[traffic] unknown address kind: ${String(kind)}`);

  if (scoped) {
    // 'tracked-project' is the only project-scoped kind: traffic::tracked-project::<id>.
    const id = cleanProjectId(projectId);
    if (!id) throw new Error(`[traffic] address kind "${kind}" requires a valid projectId (got ${JSON.stringify(projectId)})`);
    return `${PREFIX}::tracked-project::${id}`;
  }

  if (projectId !== undefined) {
    throw new Error(`[traffic] address kind "${kind}" is global and must not receive a projectId`);
  }
  return `${PREFIX}::${kind}`;
}
