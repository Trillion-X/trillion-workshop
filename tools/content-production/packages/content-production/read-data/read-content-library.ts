/**
 * file: packages/content-production/read-data/read-content-library.ts
 *
 * PURPOSE: Pure queries for the Library surface (plan §13A U02) — turn the
 * package's contentMediaEvidence feed into a flat, searchable list of media
 * sources (files, recordings, prior production outputs) the user can pick to
 * make content from.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Never imports from slot::workflow or slot::eeaf — pure data over the evidence feed
 * 2. Source packages are discovered from run-profile source_inputs DATA, never enumerated here
 * 3. Zero side effects, zero writes
 */

import {
  readEvidenceProjection,
} from '@/packages/content-media-evidence/read-data/content-media-evidence';

import {
  firstRunProfile,
  readContentProductionEvidence,
  readSourceOptions,
  sourceInputs,
  type ContentProductionSourceOption,
} from '@/packages/content-production/read-data/read-content-production';

export type ContentLibraryItem = {
  id: string;
  label: string;
  /** Which evidence package published this source (e.g. local-files, cloud-files). */
  sourcePackage: string;
  /** The opaque source_ref the production run consumes. */
  sourceRef: Record<string, unknown>;
  /** Raw payload for detail rendering (media type, timestamps when present). */
  raw: Record<string, unknown>;
  /** When the source was captured/added, when the payload says so. */
  recordedAt: string | null;
  /** Clip length in milliseconds, when the payload says so. */
  durationMs: number | null;
  /** Human media kind word (Audio/Video/Image/File) — raw MIME never renders. */
  kindLabel: string;
};

/** Human media-kind word from a MIME-ish string — raw MIME never renders. */
export function mediaKindLabel(mediaType: string | null): string {
  const family = mediaType?.split('/')[0]?.toLowerCase();
  if (family === 'audio') return 'Audio';
  if (family === 'video') return 'Video';
  if (family === 'image') return 'Image';
  return 'File';
}

/** "3:24" from milliseconds; null-safe. */
export function durationLabel(durationMs: number | null): string | null {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export type ContentLibraryOutputItem = {
  id: string;
  label: string;
  completedAt: string | null;
  raw: Record<string, unknown>;
};

function textField(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * All pickable sources, flattened across every source_input the active
 * run-profile declares. The profile's source_inputs list IS the package
 * catalog — adding a provider package is run-profile data, zero code here.
 */
export function readContentLibraryItems(evidenceRows: unknown): ContentLibraryItem[] {
  const evidence = readContentProductionEvidence(evidenceRows);
  // The Library lists pickable sources, so it follows the profile that
  // DECLARES source_inputs — not merely the first executable profile.
  // Profiles without source inputs (e.g. render-only) cannot describe a library.
  const profile = evidence.runProfiles.find((candidate) => sourceInputs(candidate).length > 0)
    ?? firstRunProfile(evidence.runProfiles);
  return sourceInputs(profile)
    .flatMap((input) => readSourceOptions(evidenceRows, input))
    .map((option: ContentProductionSourceOption) => {
      const raw = option.raw;
      const durationValue = raw['duration_ms'];
      return {
        id: option.id,
        label: option.label,
        sourcePackage: option.input.evidence_package ?? '',
        sourceRef: option.sourceRef,
        raw,
        recordedAt: textField(raw, ['recorded_at', 'created_at', 'added_at', 'captured_at']),
        durationMs: typeof durationValue === 'number' && Number.isFinite(durationValue) ? durationValue : null,
        kindLabel: mediaKindLabel(textField(raw, ['media_type', 'content_type'])),
      };
    })
    .sort((left, right) => {
      const leftTime = Date.parse(left.recordedAt ?? '');
      const rightTime = Date.parse(right.recordedAt ?? '');
      return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
    })
    // The same source can be witnessed by several evidence rows (e.g. the
    // recorder row plus an aggregate echo). One library row per source id.
    .filter((item, index, all) => all.findIndex(
      (other) => other.id === item.id && other.sourcePackage === item.sourcePackage,
    ) === index);
}

/** Finished production outputs, newest first — the "what I already made" rail. */
export function readContentLibraryOutputs(evidenceRows: unknown): ContentLibraryOutputItem[] {
  const projection = readEvidenceProjection(evidenceRows, 'content-production');
  return (projection.rowsByRole['outputs'] ?? [])
    .map((row) => row.payload)
    .filter((payload): payload is Record<string, unknown> => !!payload && typeof payload === 'object' && !Array.isArray(payload))
    .map((payload) => ({
      id: textField(payload, ['output_id', 'run_id']) ?? '',
      label: textField(payload, ['label', 'title', 'output_id', 'run_id']) ?? 'Output',
      completedAt: textField(payload, ['completed_at']),
      raw: payload,
    }))
    .filter((item) => item.id.length > 0)
    .sort((left, right) => {
      const leftTime = Date.parse(left.completedAt ?? '');
      const rightTime = Date.parse(right.completedAt ?? '');
      return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
    });
}

/** A source package id → plain user words (unknown ids read as themselves, de-hyphenated). */
const SOURCE_PACKAGE_LABELS: Record<string, string> = {
  'local-files': 'This computer',
  'cloud-files': 'Cloud',
  'record-audio': 'Recordings',
  'record-video': 'Videos',
  'content-production': 'Made here',
};

export function sourcePackageLabel(sourcePackage: string): string {
  return SOURCE_PACKAGE_LABELS[sourcePackage] ?? sourcePackage.replace(/[-_]/g, ' ');
}

/** Render an ISO timestamp in user words; raw value only when unparseable. */
export function friendlyDate(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Case-insensitive substring filter over label + source package. */
export function filterContentLibraryItems(
  items: readonly ContentLibraryItem[],
  search: string,
): ContentLibraryItem[] {
  const query = search.trim().toLowerCase();
  if (!query) return [...items];
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(query) ||
      item.sourcePackage.toLowerCase().includes(query) ||
      sourcePackageLabel(item.sourcePackage).toLowerCase().includes(query),
  );
}
