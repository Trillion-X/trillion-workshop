// tools/published-destinations/read-data/read-destination.mjs
//
// Pure, bounded decoders for destination descriptors an owner has published. A destination is a screen's worth of
// facts (a statement, sections of items, stats, bars) that the owner has already worked out. This file only reads
// them: it adds, ranks, scores and totals nothing, so what it returns is what the owner published or nothing.
//
// A section's `presentation` is an open key. It is passed through and never compared against a list, so a new kind of
// section needs no change here.

const MAX_SECTIONS = 64;
const MAX_ITEMS_PER_SECTION = 200;
const MAX_STATS_PER_SECTION = 24;
const MAX_BARS_PER_SECTION = 96;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function bounded(values, max) {
  return values.length > max ? values.slice(0, max) : values;
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function decodeItem(raw) {
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
    tone: text(raw.tone),
    icon: text(raw.icon),
    actor: text(raw.actor),
    rank: num(raw.rank),
    color: text(raw.color),
    celebrate: raw.celebrate === true ? true : undefined,
  };
}

function decodeSection(raw) {
  if (!isRecord(raw)) return null;
  const presentation = text(raw.presentation);
  if (!presentation) return null;
  const items = Array.isArray(raw.items)
    ? bounded(raw.items, MAX_ITEMS_PER_SECTION).map(decodeItem).filter((item) => item !== null)
    : undefined;
  const stats = Array.isArray(raw.stats)
    ? bounded(raw.stats, MAX_STATS_PER_SECTION).flatMap((stat) => {
        if (!isRecord(stat)) return [];
        const value = text(stat.value);
        const label = text(stat.label);
        return value && label ? [{ value, label, tone: text(stat.tone) }] : [];
      })
    : undefined;
  const bars = Array.isArray(raw.bars)
    ? bounded(raw.bars, MAX_BARS_PER_SECTION).flatMap((bar) => {
        if (!isRecord(bar)) return [];
        const value = num(bar.value);
        return value === undefined ? [] : [{ value, tone: text(bar.tone), color: text(bar.color), title: text(bar.title) }];
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

/** A descriptor with a statement and at least one valid section, or null. Past the bounds, a valid prefix is kept. */
export function decodeDestinationDescriptor(raw) {
  if (!isRecord(raw)) return null;
  const statement = text(raw.statement);
  if (!statement || !Array.isArray(raw.sections)) return null;
  const sections = bounded(raw.sections, MAX_SECTIONS).map(decodeSection).filter((section) => section !== null);
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

/** The refs of items the owner marked to celebrate that the owner's own numbers say are complete. */
export function finishedCelebratingRefs(descriptor) {
  const refs = [];
  for (const section of descriptor.sections) {
    for (const item of section.items ?? []) {
      if (item.celebrate && item.percent !== undefined && item.percent >= 100) refs.push(item.ref);
    }
  }
  return refs;
}

/**
 * Find a published descriptor by its opaque ref in rows shaped `{ record, payload }` (the payload is the decoded
 * record, never a string to parse). A descriptor that names a subject is found only when the caller names the same
 * subject; with no subject given it is skipped, never guessed.
 */
export function findDestinationDescriptor(rows, ref, subjectRef) {
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const parsed = row.payload;
    if (!isRecord(parsed) || parsed.kind !== 'destination-descriptor' || text(parsed.ref) !== ref) continue;
    const ownerSubject = text(parsed.subject_ref) ?? text(parsed.subjectRef);
    if (ownerSubject && (!subjectRef || ownerSubject !== subjectRef)) continue;
    const decoded = decodeDestinationDescriptor(parsed);
    if (decoded) return decoded;
  }
  return null;
}
