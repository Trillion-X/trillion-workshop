import { isAdmittedProjectionScope } from './read-group-page.ts';

type JsonRecord = Record<string, unknown>;
export type SubjectSurface = {
  ref: string;
  label: string;
  target?: string;
  materialTarget: string;
  packageEntry?: { packageName: string; entryName: string };
  icon?: string;
  surfaceInput?: JsonRecord;
};

const record = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
function decoded(value: unknown): JsonRecord | null {
  if (record(value)) return value;
  if (typeof value !== 'string') return null;
  try { const parsed = JSON.parse(value); return record(parsed) ? parsed : null; } catch { return null; }
}
function packageEntry(value: unknown) {
  const entry = record(value) ? value : null; const packageName = text(entry?.package_name) || text(entry?.packageName); const entryName = text(entry?.entry_name) || text(entry?.entryName);
  return packageName && entryName ? { packageName, entryName } : undefined;
}

/** Decode only canonical placeable-surface rows whose declared subject is the admitted subject. */
export function findSubjectSurfaces(rows: unknown, scope: unknown): SubjectSurface[] {
  if (!Array.isArray(rows) || !isAdmittedProjectionScope(scope)) return [];
  const found: SubjectSurface[] = []; const seen = new Set<string>();
  for (const rowValue of rows) {
    if (!record(rowValue)) continue;
    const payload = decoded(rowValue.payload) ?? decoded(rowValue.value) ?? decoded(rowValue.path);
    if (!payload || payload.kind !== 'placeable-surface') continue;
    const surfaceInput = record(payload.surface_input) ? payload.surface_input : record(payload.surfaceInput) ? payload.surfaceInput : undefined;
    const publicScope = record(surfaceInput?.public_scope) ? surfaceInput.public_scope : null;
    const admittedScope = record(surfaceInput?.admitted_scope) ? surfaceInput.admitted_scope : null;
    const subjectRef = text(payload.subject_ref)
      || text(payload.scope_ref)
      || text(surfaceInput?.subject_ref)
      || text(surfaceInput?.scope_ref)
      || text(publicScope?.subject_ref)
      || text(publicScope?.scope_ref)
      || text(admittedScope?.subject_ref)
      || text(admittedScope?.scope_ref)
      || text(rowValue.subject_ref)
      || text(rowValue.scope_ref);
    if (subjectRef !== scope.subject_ref) continue;
    const ref = text(payload.id) || text(payload.surface_id) || text(rowValue.address);
    const label = text(payload.label) || text(payload.title) || text(payload.name);
    const materialTarget = text(payload.material_target) || text(payload.materialTarget);
    if (!ref || !label || !materialTarget || seen.has(ref)) continue;
    seen.add(ref);
    found.push({
      ref,
      label,
      materialTarget,
      ...(text(payload.target) ? { target: text(payload.target) } : {}),
      ...(packageEntry(payload.package_entry ?? payload.packageEntry) ? { packageEntry: packageEntry(payload.package_entry ?? payload.packageEntry) } : {}),
      ...(text(payload.icon) ? { icon: text(payload.icon) } : {}),
      ...(surfaceInput ? { surfaceInput: JSON.parse(JSON.stringify(surfaceInput)) as JsonRecord } : {}),
    });
  }
  return found;
}
