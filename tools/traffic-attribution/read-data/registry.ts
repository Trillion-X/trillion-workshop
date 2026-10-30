// tools/traffic-attribution/read-data/registry.ts
//
// The tracked-project registry: the generative primitive (L069). One row per
// project the operator tracks. A new project = ONE row, zero code. Every
// downstream stage (capture, rollup, projection, board) is keyed by the row's
// projectId DATA — no project name lives in code.
//
// A registry row also carries the DATA the projection needs (conversion metric +
// dimension descriptors), so adding a project also configures its board without
// code. Pure: no I/O, no clock, no React.

import { isValidProjectId } from './traffic-address.ts';

export const TRACKED_PROJECT_RECORD_KIND = 'tracked-project';

/** One traffic dimension the board can break traffic down by (DATA). */
export interface TrackedProjectDimension {
  /** dimension id (e.g. "source", "utm_campaign") — also the signal key. */
  id: string;
  /** human column label (e.g. "Source"). */
  label: string;
}

/** One tracked outcome the board shows as a conversion column (DATA). */
export interface TrackedProjectOutcome {
  /** outcome id = the conversion fact's `metric` key (e.g. "lead", "purchase"). */
  id: string;
  /** human column label (e.g. "Leads", "Purchases"). */
  label: string;
}

/** A registry row: everything needed to capture + display one project's traffic. */
export interface TrackedProject {
  kind: typeof TRACKED_PROJECT_RECORD_KIND;
  /** DATA project id token (no project name in code — this is the value). */
  projectId: string;
  /** human label shown on the board ("Traffic & Sources — <label>"). */
  label: string;
  /**
   * The PRIMARY conversion outcome key (DATA, e.g. "purchase"). Kept as the default
   * a metric-less conversion counts toward (L116) and the first board column. Equals
   * conversionMetrics[0].id.
   */
  conversionMetric: string;
  /**
   * Every outcome the board shows as its OWN conversion column (DATA — the funnel:
   * e.g. [{lead},{purchase}]). A new outcome type is a DATA row, zero code. Always
   * non-empty (derived from conversionMetric when only the singular is supplied).
   */
  conversionMetrics: TrackedProjectOutcome[];
  /** dimensions to break traffic down by (DATA rows). */
  dimensions: TrackedProjectDimension[];
  /** ISO 4217 currency code for revenue display (DATA, optional; the board defaults to USD). */
  currency?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function readDimensions(raw: unknown): TrackedProjectDimension[] {
  if (!Array.isArray(raw)) return [];
  const out: TrackedProjectDimension[] = [];
  for (const d of raw) {
    if (!isRecord(d)) continue;
    const id = typeof d.id === 'string' ? d.id.trim() : '';
    if (!id) continue;
    const label = typeof d.label === 'string' && d.label.trim() ? d.label.trim() : id;
    out.push({ id, label });
  }
  return out;
}

/**
 * Read the tracked outcome columns (DATA). Accepts an array of {id,label} OR plain
 * id strings. Empty/invalid -> [] (caller derives a default from conversionMetric so
 * conversionMetrics is never empty). Deduped by id, first label wins.
 */
function readOutcomes(raw: unknown): TrackedProjectOutcome[] {
  if (!Array.isArray(raw)) return [];
  const out: TrackedProjectOutcome[] = [];
  const seen = new Set<string>();
  for (const o of raw) {
    let id = '';
    let label = '';
    if (typeof o === 'string') {
      id = o.trim();
    } else if (isRecord(o)) {
      id = typeof o.id === 'string' ? o.id.trim() : '';
      label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : '';
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: label || id });
  }
  return out;
}

/** Narrow one unknown payload to a TrackedProject, or null if invalid. */
export function readTrackedProject(raw: unknown): TrackedProject | null {
  if (!isRecord(raw)) return null;
  if (raw.kind !== TRACKED_PROJECT_RECORD_KIND) return null;
  if (!isValidProjectId(raw.projectId)) return null;
  const projectId = (raw.projectId as string).trim();
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : projectId;
  const singular =
    typeof raw.conversionMetric === 'string' && raw.conversionMetric.trim()
      ? raw.conversionMetric.trim()
      : 'purchase';
  // conversionMetrics (DATA, the funnel columns); derive from the singular when absent
  // so older single-outcome rows render identically (label "Conversions").
  const explicit = readOutcomes(raw.conversionMetrics);
  const conversionMetrics = explicit.length > 0 ? explicit : [{ id: singular, label: 'Conversions' }];
  const conversionMetric = conversionMetrics[0].id; // primary = first column / metric-less default
  const dimensions = readDimensions(raw.dimensions);
  const currency = typeof raw.currency === 'string' && raw.currency.trim() ? raw.currency.trim() : undefined;
  return { kind: TRACKED_PROJECT_RECORD_KIND, projectId, label, conversionMetric, conversionMetrics, dimensions, ...(currency ? { currency } : {}) };
}

/** Read the enumerable tracked-project list (accepts array or {records:[]}). */
export function readTrackedProjects(raw: unknown): TrackedProject[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.records)
      ? raw.records
      : [];
  const out: TrackedProject[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const project = readTrackedProject(entry);
    if (project && !seen.has(project.projectId)) {
      seen.add(project.projectId);
      out.push(project);
    }
  }
  return out;
}

/** Build a well-formed registry row payload (used by the "Track a project" UI). */
export function buildTrackedProjectRecord(input: {
  projectId: string;
  label?: string;
  conversionMetric?: string;
  conversionMetrics?: Array<TrackedProjectOutcome | string>;
  dimensions?: TrackedProjectDimension[];
  currency?: string;
}): TrackedProject | null {
  if (!isValidProjectId(input.projectId)) return null;
  const projectId = input.projectId.trim();
  const explicit = readOutcomes(input.conversionMetrics);
  const singular = input.conversionMetric?.trim() || 'purchase';
  const conversionMetrics = explicit.length > 0 ? explicit : [{ id: singular, label: 'Conversions' }];
  const currency = input.currency?.trim() || undefined;
  return {
    kind: TRACKED_PROJECT_RECORD_KIND,
    projectId,
    label: input.label?.trim() || projectId,
    conversionMetric: conversionMetrics[0].id,
    conversionMetrics,
    dimensions:
      input.dimensions && input.dimensions.length > 0
        ? readDimensions(input.dimensions)
        : [{ id: 'source', label: 'Source' }],
    ...(currency ? { currency } : {}),
  };
}
