// packages/screen-arrangement/read-data/always-mount-companions.ts
//
// Parse the optional "always-mount-companions" DATA list for the screen-arrangement
// ROOT. This is the GENERIC, app-agnostic seam (L069) that lets ANY workspace app
// mount cross-cutting HEADLESS companions (a traffic-capture beacon, an analytics
// pixel, a consent init) on cold boot WITHOUT a per-app source edit: the app writes
// ONE DATA record (a list of package entry references) and the root mounts each via
// CompanionMounts for its on-mount EFFECT. Absent/empty record → zero companions →
// the root renders exactly as before (additive, no regression).
//
// Names no package, no app, no domain — companions are PackageEntryReference DATA
// (the same shape ComponentMaterialSurface/CompanionMounts already consume). Pure:
// no I/O, no React, no clock — fully unit-testable.

import type { PackageEntryReference } from './layout-types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Narrow one unknown entry to a PackageEntryReference, or null if invalid.
 *  Accepts camelCase (packageName/entryName) or snake_case (package_name/entry_name)
 *  so the DATA record can be authored either way. */
function readEntry(raw: unknown): PackageEntryReference | null {
  if (!isRecord(raw)) return null;
  const packageName = raw.packageName ?? raw.package_name;
  const entryName = raw.entryName ?? raw.entry_name;
  if (typeof packageName !== 'string' || typeof entryName !== 'string') return null;
  const p = packageName.trim();
  const e = entryName.trim();
  if (!p || !e) return null;
  return { packageName: p, entryName: e };
}

/**
 * Read the always-mount-companions list from whatever the input returned. Accepts a
 * bare array, `{ companions: [...] }`, or `{ records: [...] }` (the common record-list
 * shapes), and returns a de-duplicated PackageEntryReference[] (empty when absent or
 * malformed — never throws, so a bad record can never break the workspace root).
 */
export function readAlwaysMountCompanions(raw: unknown): PackageEntryReference[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.companions)
      ? raw.companions
      : isRecord(raw) && Array.isArray(raw.records)
        ? raw.records
        : [];
  const out: PackageEntryReference[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const ref = readEntry(entry);
    if (!ref) continue;
    const key = `${ref.packageName} ${ref.entryName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}
