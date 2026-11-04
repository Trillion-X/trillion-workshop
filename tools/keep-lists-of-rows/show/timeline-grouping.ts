//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure grouping/labeling logic for the kind:'timeline' visual-database view.
// Records bucket by their ACTUAL day (chronological, undated last) — the
// structural difference from the list's relative buckets, which collapse time
// into Today/Tomorrow/Earlier. This leaf imports ONLY read-data types and the
// field-text reader (no UI), so it is unit-testable without the ui barrel.
//
// Generic: no field vocabulary ships here. The day source is whatever date
// descriptor the caller resolves (the view's dateField or the date-role field).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { extractFieldText } from '../read-data/visual-database';
import type {
  VisualDatabaseFieldDescriptor,
  VisualDatabaseRecord,
} from '../read-data/visual-database';

/** The ISO day (YYYY-MM-DD) a record falls on for the timeline, or null when it
 *  carries no date. Generic: reads the supplied date descriptor, falling back
 *  to the record's own date. */
export function timelineDayKey(
  record: VisualDatabaseRecord,
  dateDescriptor: VisualDatabaseFieldDescriptor | null,
): string | null {
  const raw = dateDescriptor ? extractFieldText(record, dateDescriptor)[0] ?? '' : record.date ?? '';
  const match = raw.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

/** The bucket boundary a given ISO day belongs to at a zoom level. Zoom is view
 *  DATA (an opaque string); unknown zooms degrade to day so a mistyped view row
 *  still renders honestly instead of crashing. Week buckets anchor on Monday
 *  (ISO 8601). Pure string/date arithmetic — no locale, no timezone reads: the
 *  ISO day is already the record's resolved calendar day. */
export function timelineBucketKey(isoDay: string, zoom: string | undefined): string {
  const [y, m, d] = isoDay.split('-').map(Number);
  switch (zoom) {
    case 'year':
      return `${isoDay.slice(0, 4)}`;
    case 'quarter':
      return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
    case 'month':
      return isoDay.slice(0, 7);
    case 'week': {
      // Monday of the ISO week, as its own YYYY-MM-DD — sorts chronologically for free.
      const date = new Date(Date.UTC(y, m - 1, d));
      const dow = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
      date.setUTCDate(date.getUTCDate() - dow);
      return date.toISOString().slice(0, 10);
    }
    default:
      return isoDay;
  }
}

/** Group records into chronological buckets at a zoom level (past→future,
 *  undated last). At zoom 'day' (or undefined/unknown) this is exactly
 *  {@link timelineDayGroups}. Bucket keys are chosen to sort lexicographically
 *  in chronological order at every zoom (YYYY, YYYY-Qn, YYYY-MM, YYYY-MM-DD). */
export function timelineBucketGroups(
  records: readonly VisualDatabaseRecord[],
  dateDescriptor: VisualDatabaseFieldDescriptor | null,
  zoom: string | undefined,
): Array<{ bucket: string | null; records: VisualDatabaseRecord[] }> {
  const byBucket = new Map<string | null, VisualDatabaseRecord[]>();
  for (const record of records) {
    const day = timelineDayKey(record, dateDescriptor);
    const bucket = day === null ? null : timelineBucketKey(day, zoom);
    const list = byBucket.get(bucket);
    if (list) list.push(record);
    else byBucket.set(bucket, [record]);
  }
  return [...byBucket.keys()]
    .sort((left, right) => {
      if (left === null) return 1;
      if (right === null) return -1;
      return left.localeCompare(right);
    })
    .map((bucket) => ({ bucket, records: byBucket.get(bucket) ?? [] }));
}

/** Humanize a bucket key for its zoom. Day keys defer to
 *  {@link humanizeTimelineDay}; coarser keys label their span plainly. */
export function humanizeTimelineBucket(bucket: string, zoom: string | undefined, todayIso: string): string {
  if (/^\d{4}$/.test(bucket)) return bucket;
  if (/^\d{4}-Q\d$/.test(bucket)) return `Q${bucket.slice(6)} ${bucket.slice(0, 4)}`;
  if (/^\d{4}-\d{2}$/.test(bucket)) {
    const parsed = new Date(`${bucket}-01T00:00:00`);
    return `${parsed.toLocaleDateString(undefined, { month: 'long' })} ${bucket.slice(0, 4)}`;
  }
  if (zoom === 'week') {
    const parsed = new Date(`${bucket}T00:00:00`);
    return `Week of ${parsed.toLocaleDateString(undefined, { month: 'short' })} ${parsed.getDate()}`;
  }
  return humanizeTimelineDay(bucket, todayIso);
}

/** Group records into chronological day buckets (past→future, undated last).
 *  Every distinct date keeps its own marker — the structural difference from
 *  the list's relative buckets. */
export function timelineDayGroups(
  records: readonly VisualDatabaseRecord[],
  dateDescriptor: VisualDatabaseFieldDescriptor | null,
): Array<{ day: string | null; records: VisualDatabaseRecord[] }> {
  const byDay = new Map<string | null, VisualDatabaseRecord[]>();
  for (const record of records) {
    const day = timelineDayKey(record, dateDescriptor);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(record);
    else byDay.set(day, [record]);
  }
  return [...byDay.keys()]
    .sort((left, right) => {
      if (left === null) return 1;
      if (right === null) return -1;
      return left.localeCompare(right);
    })
    .map((day) => ({ day, records: byDay.get(day) ?? [] }));
}

/** Humanize an ISO day (YYYY-MM-DD) into a stable label with a relative hint
 *  for the near days (Things 3 "Upcoming" / Amie agenda anatomy). No
 *  vocabulary shipped: the date itself is the label. */
export function humanizeTimelineDay(isoDay: string, todayIso: string): string {
  const diff = Math.round((Date.parse(isoDay) - Date.parse(todayIso)) / 86400000);
  const relative = diff === 0 ? 'Today' : diff === -1 ? 'Yesterday' : diff === 1 ? 'Tomorrow' : null;
  const parsed = new Date(`${isoDay}T00:00:00`);
  const weekday = parsed.toLocaleDateString(undefined, { weekday: 'short' });
  const month = parsed.toLocaleDateString(undefined, { month: 'short' });
  const dated = `${weekday}, ${month} ${parsed.getDate()}`;
  return relative ? `${relative} · ${dated}` : dated;
}
