// package://packages/destination-surface/read-data/read-destination.ts
//
// Pure, bounded decoders for owner-published destination descriptors. This
// package renders values; effect aggregation, progression, ranks, and history
// remain authoritative owner projections and never execute in the browser.

export interface DestinationStat {
  value: string;
  label: string;
  tone?: 'default' | 'positive' | 'accent';
}

export interface DestinationItem {
  ref: string;
  title: string;
  detail?: string;
  percent?: number;
  fraction?: string;
  meta?: string;
  featured?: boolean;
  actionLabel?: string;
  imageUrl?: string;
  chip?: string;
  tone?: 'accent' | 'positive' | 'warm' | 'neutral';
  icon?: string;
  actor?: string;
  rank?: number;
  color?: string;
  /** Presentational only: the owner projection already decided completion. */
  celebrate?: boolean;
}

export interface DestinationSection {
  /** Open renderer capability key resolved by the shared blind registry. */
  presentation: string;
  label?: string;
  detail?: string;
  column?: 'main' | 'rail';
  items?: DestinationItem[];
  stats?: DestinationStat[];
  percent?: number;
  ringLabel?: string;
  color?: string;
  bars?: Array<{ value: number; tone?: 'positive' | 'warm' | 'accent' | 'neutral'; color?: string; title?: string }>;
  body?: string;
  meta?: string;
}

export interface DestinationDescriptor {
  ref: string;
  subjectRef?: string;
  projectionRef?: string;
  progressionRef?: string;
  kicker?: string;
  statement: string;
  subtitle?: string;
  sections: DestinationSection[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const MAX_SECTIONS = 64;
const MAX_ITEMS_PER_SECTION = 200;
const MAX_STATS_PER_SECTION = 24;
const MAX_BARS_PER_SECTION = 96;

function bounded(value: readonly unknown[], max: number): readonly unknown[] {
  return value.length > max ? value.slice(0, max) : value;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function decodeItem(raw: unknown): DestinationItem | null {
  if (!isRecord(raw)) return null;
  const title = text(raw.title);
  if (!title) return null;
  return {
    ref: text(raw.ref) ?? title,
    title,
    detail: text(raw.detail),
    meta: text(raw.meta),
    featured: raw.featured === true ? true : undefined,
    actionLabel: text(raw.action_label) ?? text(raw.actionLabel),
    imageUrl: text(raw.image_url) ?? text(raw.imageUrl),
    percent: num(raw.percent),
    fraction: text(raw.fraction),
    chip: text(raw.chip),
    tone: text(raw.tone) as DestinationItem['tone'],
    icon: text(raw.icon),
    actor: text(raw.actor),
    rank: num(raw.rank),
    color: text(raw.color),
    celebrate: raw.celebrate === true ? true : undefined,
  };
}

function decodeSection(raw: unknown): DestinationSection | null {
  if (!isRecord(raw)) return null;
  const presentation = text(raw.presentation);
  if (!presentation) return null;
  const items = Array.isArray(raw.items)
    ? bounded(raw.items, MAX_ITEMS_PER_SECTION).map(decodeItem).filter((item): item is DestinationItem => item !== null)
    : undefined;
  const stats = Array.isArray(raw.stats)
    ? bounded(raw.stats, MAX_STATS_PER_SECTION).flatMap((stat) => {
        if (!isRecord(stat)) return [];
        const value = text(stat.value);
        const label = text(stat.label);
        return value && label ? [{ value, label, tone: text(stat.tone) as DestinationStat['tone'] }] : [];
      })
    : undefined;
  const bars = Array.isArray(raw.bars)
    ? bounded(raw.bars, MAX_BARS_PER_SECTION).flatMap((bar) => {
        if (!isRecord(bar)) return [];
        const value = num(bar.value);
        return value === undefined ? [] : [{
          value,
          tone: text(bar.tone) as 'positive' | 'warm' | 'accent' | 'neutral' | undefined,
          color: text(bar.color),
          title: text(bar.title),
        }];
      })
    : undefined;
  return {
    presentation,
    label: text(raw.label),
    detail: text(raw.detail),
    column: text(raw.column) === 'rail' ? 'rail' : 'main',
    items,
    stats,
    percent: num(raw.percent),
    ringLabel: text(raw.ring_label) ?? text(raw.ringLabel),
    color: text(raw.color),
    bars,
    body: text(raw.body),
    meta: text(raw.meta),
  };
}

export function decodeDestinationDescriptor(raw: unknown): DestinationDescriptor | null {
  if (!isRecord(raw)) return null;
  const statement = text(raw.statement);
  if (!statement || !Array.isArray(raw.sections)) return null;
  const sections = bounded(raw.sections, MAX_SECTIONS)
    .map(decodeSection)
    .filter((section): section is DestinationSection => section !== null);
  if (sections.length === 0) return null;
  return {
    ref: text(raw.ref) ?? statement,
    subjectRef: text(raw.subject_ref) ?? text(raw.subjectRef),
    projectionRef: text(raw.projection_ref) ?? text(raw.projectionRef),
    progressionRef: text(raw.progression_ref) ?? text(raw.progressionRef),
    kicker: text(raw.kicker),
    statement,
    subtitle: text(raw.subtitle),
    sections,
  };
}

/** Owner-decided completed items that may trigger a visual-only celebration. */
export function finishedCelebratingRefs(descriptor: DestinationDescriptor): string[] {
  const refs: string[] = [];
  for (const section of descriptor.sections) {
    for (const item of section.items ?? []) {
      if (item.celebrate && item.percent !== undefined && item.percent >= 100) refs.push(item.ref);
    }
  }
  return refs;
}

/**
 * Find an owner-published descriptor by opaque destination ref. Subject-scoped
 * rows fail closed unless the host supplies the exact server-projected subject.
 */
export function findDestinationDescriptor(
  rows: unknown,
  ref: string,
  subjectRef?: string | null,
): DestinationDescriptor | null {
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    // The input is the destination-descriptor feed (a `record_from_matching_records`
    // fold): each row is `{ record: { address, ... }, payload: <decoded object> }`,
    // the same shape every surface in the set reads. No string parsing here.
    const parsed = row.payload;
    if (!isRecord(parsed) || parsed.kind !== 'destination-descriptor' || text(parsed.ref) !== ref) continue;
    const ownerSubject = text(parsed.subject_ref) ?? text(parsed.subjectRef);
    if (ownerSubject && (!subjectRef || ownerSubject !== subjectRef)) continue;
    const decoded = decodeDestinationDescriptor(parsed);
    if (decoded) return decoded;
  }
  return null;
}
